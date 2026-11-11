import type { GraphNode, ParsedSourceFile } from "../../../core/graph/model.js";
import { withSyntaxTree, type SyntaxNode } from "../../languages/syntax/tree-sitter.js";

// Where components and templates name style classes. Two kinds of reference
// are read, both recorded on the file until the styles contributor links them
// (the styles live in other files):
//
// - `name`: a class written as a literal in `className="btn"`, `class="a b"`,
//   `:class="{ active: on }"`, `class:active`, `[ngClass]`, `[class.x]`,
//   `class:list`, or as a string in a call of a class-name helper
//   (`clsx("a", { b: on })`). Names built at run time (`btn-${size}`) are not
//   read.
// - `module`: a member of a CSS Modules import (`styles.btn`, `styles["btn"]`)
//   or of Vue's `$style`.

export type StyleRef = {
  // Function, Component or Class owner of the reference; null for the file
  // (the contributor maps it to the file's component).
  o: string | null;
  k: "name" | "module";
  n: string;
  line: number;
  // The attribute or member syntax, as the edge's `expression`.
  a: string;
  // The Import node whose binding a `module` reference goes through; null for `$style`.
  i?: string | null;
};

const CLASS_HELPERS = new Set(["clsx", "classnames", "classNames", "cn", "cx", "twMerge", "twJoin", "cc", "classcat", "clsx.default"]);
const STYLE_SOURCE = /\.(?:css|scss|sass|less)$/iu;

export function isStyleSource(source: unknown): source is string {
  return typeof source === "string" && STYLE_SOURCE.test(source.replace(/[?#].*$/su, ""));
}

// Whitespace-separated tokens of a literal that are whole class names.
function tokens(text: string): string[] {
  return text.split(/\s+/u).filter((token) => token !== "" && !/[\u0000{}$]/u.test(token));
}

// The literal class names an expression can produce: strings and static
// template literals, through parentheses, `a ? b : c`, `a && b`, `a || b`,
// arrays, and calls of class-name helpers (whose object arguments name a
// class per key). `objects` reads object keys as classes: for the argument of
// a helper, Vue's `:class` and Angular's `[ngClass]`, not of `className`.
export function literalClassNames(node: SyntaxNode | null | undefined, objects: boolean): string[] {
  if (!node) return [];
  switch (node.type) {
    case "string":
      return tokens(node.text.slice(1, -1));
    case "template_string": {
      const text = node.text.slice(1, -1).replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/gu, "\u0000");
      return tokens(text);
    }
    case "parenthesized_expression":
    case "as_expression":
    case "satisfies_expression":
    case "non_null_expression":
      return literalClassNames(node.namedChildren[0], objects);
    case "ternary_expression":
      return [
        ...literalClassNames(node.childForFieldName("consequence"), objects),
        ...literalClassNames(node.childForFieldName("alternative"), objects),
      ];
    case "binary_expression": {
      const operator = node.childForFieldName("operator")?.text;
      const right = literalClassNames(node.childForFieldName("right"), objects);
      if (operator === "&&") return right;
      if (operator === "||" || operator === "??") return [...literalClassNames(node.childForFieldName("left"), objects), ...right];
      return [];
    }
    case "array":
      return node.namedChildren.flatMap((child) => literalClassNames(child, objects));
    case "object":
      return objects ? node.namedChildren.flatMap((child) => objectKey(child)) : [];
    case "call_expression": {
      const callee = node.childForFieldName("function")?.text ?? "";
      if (!CLASS_HELPERS.has(callee)) return [];
      return (node.childForFieldName("arguments")?.namedChildren ?? []).flatMap((child) => literalClassNames(child, true));
    }
    default:
      return [];
  }
}

function objectKey(entry: SyntaxNode | null): string[] {
  if (!entry) return [];
  if (entry.type === "shorthand_property_identifier") return tokens(entry.text);
  if (entry.type !== "pair") return [];
  const key = entry.childForFieldName("key");
  if (key?.type === "property_identifier") return tokens(key.text);
  if (key?.type === "string") return tokens(key.text.slice(1, -1));
  return [];
}

// `styles.btn` and `styles["btn"]` for a local bound to a style import.
export function moduleMembers(root: SyntaxNode, locals: ReadonlySet<string>): Array<{ local: string; name: string; line: number; syntax: string }> {
  const found: Array<{ local: string; name: string; line: number; syntax: string }> = [];
  if (locals.size === 0) return found;
  const visit = (node: SyntaxNode) => {
    if (node.type === "member_expression" || node.type === "subscript_expression") {
      const object = node.childForFieldName("object");
      if (object?.type === "identifier" && locals.has(object.text)) {
        const member = node.type === "member_expression" ? node.childForFieldName("property") : node.childForFieldName("index");
        if (node.type === "member_expression" && member?.type === "property_identifier") {
          found.push({ local: object.text, name: member.text, line: node.startPosition.row + 1, syntax: `${object.text}.${member.text}` });
        } else if (node.type === "subscript_expression" && member?.type === "string") {
          const name = member.text.slice(1, -1);
          found.push({ local: object.text, name, line: node.startPosition.row + 1, syntax: `${object.text}["${name}"]` });
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return found;
}

// The Import nodes of the parsed file that bring a style sheet in by a default
// or namespace binding: local name → import id.
export function styleImportBindings(parsed: ParsedSourceFile): Map<string, string> {
  const locals = new Map<string, string>();
  for (const node of parsed.nodes) {
    if (node.label !== "Import" || !isStyleSource(node.properties.source) || typeof node.properties.bindings !== "string") continue;
    for (const binding of JSON.parse(node.properties.bindings) as Array<{ local: string; kind: string }>) {
      if (binding.kind === "default" || binding.kind === "namespace") locals.set(binding.local, node.id);
    }
  }
  return locals;
}

// The innermost Function of the file that contains `line`.
export function ownerFunction(parsed: ParsedSourceFile, line: number): string | null {
  let best: GraphNode | null = null;
  for (const node of parsed.nodes) {
    if (node.label !== "Function") continue;
    const start = node.properties.line;
    const end = node.properties.endLine;
    if (typeof start !== "number" || typeof end !== "number" || line < start || line > end) continue;
    if (!best || start >= Number(best.properties.line)) best = node;
  }
  return best?.id ?? null;
}

export function addStyleRefs(parsed: ParsedSourceFile, fileNodeId: string, refs: readonly StyleRef[]): void {
  if (refs.length === 0) return;
  const file = parsed.nodes.find((node) => node.id === fileNodeId);
  if (!file) return;
  const previous = typeof file.properties.styleRefs === "string" ? (JSON.parse(file.properties.styleRefs) as StyleRef[]) : [];
  file.properties.styleRefs = JSON.stringify([...previous, ...refs]);
}

// ---- templates

export type TemplateDialect = "html" | "vue" | "svelte" | "astro" | "angular";

type Found = { names: string[]; modules: Array<{ name: string; syntax: string }>; attribute: string };

// The class references of one attribute of an HTML-grammar tree. `source` is
// the text the tree's offsets point into (the original file: Svelte and Astro
// expressions are masked in the tree).
export async function attributeClassRefs(attribute: SyntaxNode, source: string, dialect: TemplateDialect): Promise<Found | null> {
  const text = source.slice(attribute.startIndex, attribute.endIndex);
  const equals = text.indexOf("=");
  const name = (equals === -1 ? text : text.slice(0, equals)).trim();
  let value = equals === -1 ? "" : text.slice(equals + 1).trim();
  const quoted = /^(["'])([\s\S]*)\1$/u.exec(value);
  if (quoted) value = quoted[2]!;
  const lower = name.toLowerCase();

  if (dialect === "svelte" && lower.startsWith("class:")) {
    const directive = name.slice("class:".length).split(/[=|]/u)[0] ?? "";
    return /^[\w-]+$/u.test(directive) ? { names: [directive], modules: [], attribute: "class:" } : null;
  }
  // Angular syntax is read in every HTML-grammar file: `.html` templates carry it.
  const angular = dialect === "angular" || dialect === "html";
  if (angular && /^\[class\.[\w-]+\]$/u.test(name)) {
    return { names: [name.slice("[class.".length, -1)], modules: [], attribute: "[class.]" };
  }

  let expression: string | null = null;
  let literal: string | null = null;
  let attributeName = name;
  if (lower === "class") {
    if (dialect === "svelte" || dialect === "astro") {
      // `class="a {b} c"` and `class={expr}`: literal text and expressions.
      const parts = braceParts(value);
      const names = parts.flatMap((part) => (part.expression ? [] : tokens(part.text)));
      const expressions = parts.filter((part) => part.expression).map((part) => part.text);
      const nested = await expressionClassRefs(expressions, true);
      return { names: [...names, ...nested.names], modules: nested.modules, attribute: "class" };
    }
    // `class="a {{ b }}"`: the interpolation is not a class name.
    literal = value.replace(/\{\{[\s\S]*?\}\}/gu, "\u0000");
  } else if (dialect === "vue" && (lower === ":class" || lower === "v-bind:class")) {
    expression = value;
    attributeName = ":class";
  } else if (angular && (name === "[ngClass]" || name === "[class]")) {
    expression = value;
  } else if (dialect === "astro" && lower === "class:list") {
    expression = value.replace(/^\{([\s\S]*)\}$/u, "$1");
  } else {
    return null;
  }
  if (literal !== null) return { names: tokens(literal), modules: [], attribute: "class" };
  const nested = await expressionClassRefs([expression ?? ""], true);
  return { names: nested.names, modules: nested.modules, attribute: attributeName };
}

// `a {b} c` → text parts and `{…}` expressions, braces balanced.
function braceParts(value: string): Array<{ text: string; expression: boolean }> {
  const parts: Array<{ text: string; expression: boolean }> = [];
  let text = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "{") {
      text += value[index];
      index += 1;
      continue;
    }
    let depth = 0;
    let end = index;
    for (; end < value.length; end += 1) {
      if (value[end] === "{") depth += 1;
      else if (value[end] === "}" && --depth === 0) break;
    }
    // Text touching a `{…}` is part of a computed name (`btn-{size}`): drop it.
    if (text !== "") parts.push({ text: /\s$/u.test(text) ? text : text.replace(/\S+$/u, ""), expression: false });
    text = "";
    parts.push({ text: value.slice(index + 1, end), expression: true });
    index = end + 1;
    if (value[index] !== undefined && !/\s/u.test(value[index]!)) {
      while (index < value.length && !/\s/u.test(value[index]!)) index += 1;
    }
  }
  if (text !== "") parts.push({ text, expression: false });
  return parts;
}

// Class names and `$style` members of JS expressions.
async function expressionClassRefs(expressions: readonly string[], objects: boolean): Promise<{ names: string[]; modules: Array<{ name: string; syntax: string }> }> {
  const names: string[] = [];
  const modules: Array<{ name: string; syntax: string }> = [];
  for (const expression of expressions) {
    if (!/["'`{[]|\$style/u.test(expression)) continue;
    await withSyntaxTree("javascript", `(${expression}\n)`, (tree) => {
      const statement = tree.rootNode.namedChildren[0];
      names.push(...literalClassNames(statement?.namedChildren[0], objects));
      for (const member of moduleMembers(tree.rootNode, new Set(["$style"]))) modules.push({ name: member.name, syntax: member.syntax });
    });
  }
  return { names, modules };
}

// Every class reference of the attributes in a tree, with the line of each
// attribute, owned by `owner` (null: the file's component).
export async function templateStyleRefs(
  documentNode: SyntaxNode,
  source: string,
  dialect: TemplateDialect,
  owner: string | null,
): Promise<StyleRef[]> {
  const refs: StyleRef[] = [];
  const attributes: SyntaxNode[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "script_element" || node.type === "style_element") return;
    if (node.type === "start_tag" || node.type === "self_closing_tag") {
      for (const child of node.namedChildren) if (child?.type === "attribute") attributes.push(child);
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(documentNode);
  for (const attribute of attributes) {
    const found = await attributeClassRefs(attribute, source, dialect);
    if (!found) continue;
    const line = attribute.startPosition.row + 1;
    for (const name of new Set(found.names)) refs.push({ o: owner, k: "name", n: name, line, a: found.attribute });
    for (const member of found.modules) refs.push({ o: owner, k: "module", n: member.name, line, a: member.syntax, i: null });
  }
  return refs;
}
