import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";

// Scope helpers shared by the Go parse plugins: what a name holds at a point
// of a file, and the literals and types values are written with.

export const FUNCTION_TYPES = new Set(["function_declaration", "method_declaration", "func_literal"]);

export type Definition = { type: string } | { value: SyntaxNode } | null;

// Every Go parse plugin gets the same root node, and several ask it the same
// questions (the call expressions, the imports, the constants, a name's
// definition): the answers are kept per root, so the tree is walked once.
// Callers must not change what they get.
const perRoot = new WeakMap<SyntaxNode, Map<string, unknown>>();
export function cachedForRoot<T>(root: SyntaxNode, key: string, make: () => T): T {
  let cache = perRoot.get(root);
  if (!cache) {
    cache = new Map();
    perRoot.set(root, cache);
  }
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

export function descendantsOf(root: SyntaxNode, types: string | string[]): readonly SyntaxNode[] {
  return cachedForRoot(root, `descendants:${String(types)}`, () => root.descendantsOfType(types));
}

// What a name holds at a point: its type, or the expression it was last
// assigned before the point (in the functions around it, else at package
// level). The declarations of each function body and the package-level
// `var` specs are collected once per lookup, by name, so a lookup does not
// walk the tree again.
export function createDefinitionLookup(root: SyntaxNode): (name: string, at: SyntaxNode) => Definition {
  return cachedForRoot(root, "definitions", () => definitionLookup(root));
}

function definitionLookup(root: SyntaxNode): (name: string, at: SyntaxNode) => Definition {
  const bodies = new Map<string, Map<string, SyntaxNode[]>>();
  let packageVars: SyntaxNode[] | null = null;
  const declarationsOf = (body: SyntaxNode): Map<string, SyntaxNode[]> => {
    const key = `${body.startIndex}:${body.endIndex}`;
    let byName = bodies.get(key);
    if (byName) return byName;
    byName = new Map();
    for (const node of body.descendantsOfType(["short_var_declaration", "assignment_statement", "var_spec"])) {
      const names = node.type === "var_spec" ? node.childrenForFieldName("name") : node.childForFieldName("left")?.namedChildren ?? [];
      for (const id of names) {
        if (node.type !== "var_spec" && id.type !== "identifier") continue;
        const list = byName.get(id.text) ?? [];
        if (!list.some((existing) => same(existing, node))) list.push(node);
        byName.set(id.text, list);
      }
    }
    bodies.set(key, byName);
    return byName;
  };
  return (name: string, at: SyntaxNode): Definition => {
    for (let scope = at.parent; scope; scope = scope.parent) {
      if (!FUNCTION_TYPES.has(scope.type)) continue;
      let best: { start: number; result: { type: string } | { value: SyntaxNode } | null } | null = null;
      for (const list of [scope.childForFieldName("receiver"), scope.childForFieldName("parameters")]) {
        for (const parameter of list?.namedChildren ?? []) {
          const type = parameter.childForFieldName("type")?.text;
          if (type && parameter.childrenForFieldName("name").some((id) => id.text === name)) best = { start: -1, result: { type } };
        }
      }
      const body = scope.childForFieldName("body");
      for (const node of body ? declarationsOf(body).get(name) ?? [] : []) {
        if (node.startIndex >= at.startIndex) continue;
        if (!visibleFrom(node, at, scope)) continue;
        const result = assignmentOf(node, name);
        if (result !== undefined && (!best || node.startIndex > best.start)) best = { start: node.startIndex, result };
      }
      if (best) return best.result;
    }
    packageVars ??= descendantsOf(root, "var_spec").filter((spec) => isPackageLevel(spec));
    for (const spec of packageVars) {
      const result = assignmentOf(spec, name);
      if (result !== undefined) return result;
    }
    return null;
  };
}

export function same(left: SyntaxNode, right: SyntaxNode): boolean {
  return left.startIndex === right.startIndex && left.endIndex === right.endIndex && left.type === right.type;
}

export function assignmentOf(node: SyntaxNode, name: string): { type: string } | { value: SyntaxNode } | null | undefined {
  if (node.type === "var_spec") {
    const names = node.childrenForFieldName("name");
    const index = names.findIndex((id) => id.text === name);
    if (index === -1) return undefined;
    const type = node.childForFieldName("type")?.text;
    if (type) return { type };
    const values = node.childForFieldName("value")?.namedChildren ?? [];
    const value = values[index] ?? (values.length === 1 && index === 0 ? values[0] : undefined);
    return value ? { value } : null;
  }
  const names = node.childForFieldName("left")?.namedChildren ?? [];
  const index = names.findIndex((id) => id.type === "identifier" && id.text === name);
  if (index === -1) return undefined;
  const values = node.childForFieldName("right")?.namedChildren ?? [];
  const value = values.length === names.length ? values[index] : values.length === 1 && index === 0 ? values[0] : undefined;
  return value ? { value } : null;
}

// A declaration in a closure that does not contain the point is not seen.
export function visibleFrom(declaration: SyntaxNode, at: SyntaxNode, scope: SyntaxNode): boolean {
  for (let node = declaration.parent; node && !same(node, scope); node = node.parent) {
    if (node.type === "func_literal" && !(node.startIndex <= at.startIndex && at.endIndex <= node.endIndex)) return false;
  }
  return true;
}

export function isPackageLevel(spec: SyntaxNode): boolean {
  const declaration = spec.parent?.type === "var_declaration" ? spec.parent : spec.parent?.parent;
  return declaration?.parent?.type === "source_file";
}

export function insideFunction(node: SyntaxNode): boolean {
  for (let current = node.parent; current; current = current.parent) if (FUNCTION_TYPES.has(current.type)) return true;
  return false;
}

// The type a value is written with: `T{}`, `&T{}`, `[]T{}`, `make([]T, n)`, `new(T)`.
export function valueTypeText(value: SyntaxNode): string | undefined {
  if (value.type === "unary_expression" && value.childForFieldName("operator")?.text === "&") {
    const operand = value.childForFieldName("operand");
    return operand?.type === "composite_literal" ? valueTypeText(operand) : undefined;
  }
  if (value.type === "composite_literal") return value.childForFieldName("type")?.text;
  if (value.type === "call_expression") {
    // A conversion to a pointer type: `(*Token)(nil)`.
    const callee = value.childForFieldName("function");
    if (callee?.type === "parenthesized_expression" && callee.text.startsWith("(*")) return callee.text.slice(1, -1).trim();
    const fn = callee?.text;
    const first = value.childForFieldName("arguments")?.namedChildren[0];
    if ((fn === "make" || fn === "new") && first) return fn === "new" ? `*${first.text}` : first.text;
  }
  return undefined;
}

export function stringConstants(root: SyntaxNode): ReadonlyMap<string, string> {
  return cachedForRoot(root, "stringConstants", () => readStringConstants(root));
}

function readStringConstants(root: SyntaxNode): Map<string, string> {
  const constants = new Map<string, string>();
  for (const spec of descendantsOf(root, "const_spec")) {
    const names = spec.childrenForFieldName("name");
    const values = spec.childForFieldName("value")?.namedChildren ?? [];
    names.forEach((name, index) => {
      const value = values[index];
      if (value?.type === "interpreted_string_literal" || value?.type === "raw_string_literal") constants.set(name.text, value.text.slice(1, -1));
    });
  }
  return constants;
}
