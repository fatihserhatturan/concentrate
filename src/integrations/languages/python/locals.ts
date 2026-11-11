import type { SyntaxNode } from "../syntax/tree-sitter.js";
import { walkScoped } from "../tree-sitter-utils.js";
import { pythonParameters } from "./declarations.js";

// What a name is known to hold: an annotated type, or the result of calling
// a name (`Foo(...)`, `make()`; the resolver decides class or function).
export type LocalType = { type: string } | { constructor: string };

// `Optional[Repo]`, `Repo | None`, `"Repo"`, `Annotated[Repo, ...]` → `Repo`;
// `list[Repo]` → `list`. Anything that is not one plain (dotted) name → null.
export function normalizeType(annotation: string | null | undefined): string | null {
  if (!annotation) return null;
  let text = annotation.trim().replace(/^["']|["']$/gu, "").trim();
  for (let previous = ""; previous !== text;) {
    previous = text;
    const wrapper = /^(?:typing\.)?(?:Optional|Annotated|Final|Required|NotRequired)\[(.+)\]$/u.exec(text);
    if (wrapper) text = wrapper[1]!.split(/,(?![^\[]*\])/u)[0]!.trim();
    const union = /^(?:typing\.)?Union\[(.+)\]$/u.exec(text);
    if (union) {
      const members = union[1]!.split(/,(?![^\[]*\])/u).map((member) => member.trim()).filter((member) => member !== "None");
      if (members.length === 1) text = members[0]!;
    }
    const pipe = text.split("|").map((member) => member.trim()).filter((member) => member !== "None");
    if (pipe.length === 1 && text.includes("|")) text = pipe[0]!;
  }
  text = text.replace(/\[.*\]$/u, "");
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(text) && text !== "None" ? text : null;
}

// The call a value is: `Foo(1)` → `Foo`, `mod.make()` → `mod.make`, `await make()` → `make`.
export function calledName(value: SyntaxNode | null | undefined): string | null {
  let node = value ?? null;
  if (node?.type === "await") node = node.namedChildren[0] ?? null;
  if (node?.type !== "call") return null;
  const name = node.childForFieldName("function")?.text;
  return name && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(name) ? name : null;
}

function merge(locals: Map<string, LocalType | null>, name: string, next: LocalType | null): void {
  if (!locals.has(name)) {
    locals.set(name, next);
    return;
  }
  const previous = locals.get(name);
  // Two different values: the name's type is not known.
  if (JSON.stringify(previous) !== JSON.stringify(next)) locals.set(name, null);
}

// The names of a function body and what they hold: `self` / `cls`, annotated
// parameters, annotated and constructor-assigned variables, `with X() as y`
// and `except E as e`. A name with no known type is still listed (it shadows).
export function localTypes(fn: SyntaxNode, ownerName: string | null, methodKind: string | null): Map<string, LocalType | null> {
  const locals = new Map<string, LocalType | null>();
  const parameters = pythonParameters(fn.childForFieldName("parameters"));
  parameters.forEach((parameter, index) => {
    const name = parameter.name.replace(/^\*+/u, "");
    if (index === 0 && ownerName && methodKind !== "staticmethod" && (name === "self" || name === "cls")) {
      locals.set(name, { type: ownerName });
      return;
    }
    const type = normalizeType(parameter.type);
    locals.set(name, type ? { type } : null);
  });

  const body = fn.childForFieldName("body");
  if (!body) return locals;
  walkScoped(body, (node) => {
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left?.type === "identifier") {
        const type = normalizeType(node.childForFieldName("type")?.text);
        const called = calledName(node.childForFieldName("right"));
        merge(locals, left.text, type ? { type } : called ? { constructor: called } : null);
      } else if (left) {
        for (const identifier of left.descendantsOfType("identifier")) merge(locals, identifier.text, null);
      }
    } else if (node.type === "as_pattern") {
      const alias = node.namedChildren.find((child) => child.type === "as_pattern_target");
      const target = alias?.namedChildren[0];
      if (target?.type === "identifier") {
        const value = node.namedChildren[0];
        const called = calledName(value);
        const exception = node.parent?.type === "except_clause" || node.parent?.type === "except_group_clause";
        merge(locals, target.text, called && !exception ? { constructor: called } : exception && value ? (normalizeType(value.text) ? { type: normalizeType(value.text)! } : null) : null);
      }
    } else if (node.type === "for_statement" || node.type === "for_in_clause") {
      for (const identifier of node.childForFieldName("left")?.descendantsOfType("identifier") ?? []) merge(locals, identifier.text, null);
      if (node.childForFieldName("left")?.type === "identifier") merge(locals, node.childForFieldName("left")!.text, null);
    } else if (node.type === "named_expression") {
      const name = node.childForFieldName("name")?.text;
      if (name) merge(locals, name, null);
    } else if (node.type === "global_statement" || node.type === "nonlocal_statement") {
      // A `global x` name is the module's: not a local.
      for (const identifier of node.namedChildren) locals.delete(identifier.text);
    }
  }, (child) => child.type === "function_definition" || child.type === "class_definition" || child.type === "lambda");
  return locals;
}

export type ClassAttribute = { type: string } | { constructedBy: string };

// `self.x` assignments in the methods of a class: annotated, taken from an
// annotated parameter, or the result of a constructor call. Conflicting
// assignments leave the attribute out.
export function classAttributes(classBody: SyntaxNode | null): Record<string, ClassAttribute> {
  const attributes = new Map<string, ClassAttribute | null>();
  for (const child of classBody?.namedChildren ?? []) {
    const method = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    if (method?.type !== "function_definition") continue;
    const parameters = pythonParameters(method.childForFieldName("parameters"));
    const selfName = parameters[0]?.name;
    if (!selfName || selfName.startsWith("*")) continue;
    const parameterTypes = new Map(parameters.slice(1).map((parameter) => [parameter.name, normalizeType(parameter.type)]));
    const body = method.childForFieldName("body");
    if (!body) continue;
    walkScoped(body, (node) => {
      if (node.type !== "assignment") return;
      const left = node.childForFieldName("left");
      if (left?.type !== "attribute" || left.childForFieldName("object")?.text !== selfName) return;
      const name = left.childForFieldName("attribute")?.text;
      if (!name) return;
      const right = node.childForFieldName("right");
      const annotated = normalizeType(node.childForFieldName("type")?.text);
      const called = calledName(right);
      const fromParameter = right?.type === "identifier" ? parameterTypes.get(right.text) ?? null : null;
      const next: ClassAttribute | null = annotated ? { type: annotated } : fromParameter ? { type: fromParameter } : called ? { constructedBy: called } : null;
      if (!attributes.has(name)) attributes.set(name, next);
      else if (JSON.stringify(attributes.get(name)) !== JSON.stringify(next)) attributes.set(name, null);
    }, (inner) => inner.type === "function_definition" || inner.type === "class_definition" || inner.type === "lambda");
  }
  const result: Record<string, ClassAttribute> = {};
  for (const [name, attribute] of attributes) if (attribute) result[name] = attribute;
  return result;
}
