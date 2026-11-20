import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";
import { compactExpression, dottedName, modifiersOf, normalizeJavaType, typeText } from "../../languages/java/syntax.js";
import { createJavaTypeIndex, type JavaType, type JavaTypeIndex, type TypeScope } from "../../languages/java/types.js";

// Java string expressions as templates: what a URL, a SQL statement, a property key or a path argument
// is, as far as the code says, shared by the data, config and HTTP readers.
//
// A template is a list of parts: literal `{text}`, a dynamic `{expr}` (a parameter, a call, anything
// that is not known) and a `{ref}` (a name that may be a constant: `BASE`, `Urls.BASE`,
// `com.acme.Urls.BASE`). It is plain JSON, so a parse plugin keeps one on a node property and a
// contributor resolves it once every file is parsed.
//
// Parse time (`readJavaString`, on a syntax node) reads, left to right:
//   - string literals, text blocks (incidental indentation removed), char and integer literals,
//     parentheses and casts, `+` concatenation (any depth);
//   - `String.format(fmt, args…)` and `fmt.formatted(args…)` with a literal format: each `%s`/`%d`…
//     is the matching argument's parts, `%%` and `%n` their text; `String.valueOf(x)`,
//     `Objects.toString(x)`, `x.toString()`, `x.trim()`, `x.strip()`, `a.concat(b)` and
//     `String.join(sep, a, b)` with a literal separator;
//   - a single-assignment local (`readLocalStrings`: `String url = "/a/" + id;` never assigned
//     again) by its value;
//   - any other name is a `ref`, anything else an `expr`.
// A `static`/instance `final` String (or int/long/char) field with an initializer keeps its template on
// the Field node (`stringConstant`), written by `javaStringConstantsPlugin`.
//
// Resolution (`createJavaStringResolver`, after every file is parsed) replaces a `ref` by the
// constant it names: a field of the enclosing types (and their supertypes), a name imported with
// `import static`, or `Type.NAME` / `pkg.Type.NAME` of another scanned file (a constant that
// refers to another constant is followed; a cycle or more than eight levels stops). A name that is no
// scanned constant stays dynamic. Dynamic parts are written `${expression}` in a rendered string, the
// convention of the Python and Go HTTP clients (characters that would split a URL become `_`).
// `null` is returned when no literal text is known (`url` alone, `${a}${b}`).
//
// Not handled: a constant built by a method call, instance fields assigned in a constructor,
// `StringBuilder`, `MessageFormat`, switch and ternary values (they are `expr`).

export type JavaStringPart = { text: string } | { expr: string } | { ref: string };
export type JavaStringTemplate = JavaStringPart[];

const MAX_DEPTH = 8;
const CONSTANT_TYPES = new Set(["String", "java.lang.String", "int", "long", "short", "char", "Integer", "Long"]);
// Methods of a string (or number) that do not change what the text is known to be.
const PASS_THROUGH = new Set(["toString", "trim", "strip", "intern", "stripLeading", "stripTrailing"]);

const isComment = (node: SyntaxNode) => node.type.endsWith("comment");

// ---------------------------------------------------------------- templates

export const hasLiteralText = (template: JavaStringTemplate): boolean => template.some((part) => "text" in part && part.text !== "");

export function serializeJavaString(template: JavaStringTemplate): string {
  return JSON.stringify(template);
}

export function parseJavaString(value: unknown): JavaStringTemplate | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as JavaStringTemplate) : null;
  } catch {
    return null;
  }
}

// Adjacent texts merged, empty ones dropped.
function tidy(parts: JavaStringTemplate): JavaStringTemplate {
  const result: JavaStringTemplate = [];
  for (const part of parts) {
    const last = result.at(-1);
    if ("text" in part) {
      if (part.text === "") continue;
      if (last && "text" in last) result[result.length - 1] = { text: last.text + part.text };
      else result.push(part);
    } else result.push(part);
  }
  return result;
}

const placeholder = (expression: string): string => `\${${expression.replace(/[{}/\s?#]/gu, "_")}}`;

/** The template as one string; unresolved names and expressions are `${name}`. */
export function renderJavaString(template: JavaStringTemplate): string {
  return template.map((part) => ("text" in part ? part.text : placeholder("expr" in part ? part.expr : part.ref))).join("");
}

// ---------------------------------------------------------------- literals

function unescape(body: string): string {
  return body.replace(/\\(u+[0-9a-fA-F]{4}|[btnfrs"'\\]|[0-7]{1,3}|\r?\n)/gu, (_match, code: string) => {
    if (code.startsWith("u")) return String.fromCharCode(parseInt(code.replace(/^u+/u, ""), 16));
    if (/^[0-7]+$/u.test(code)) return String.fromCharCode(parseInt(code, 8));
    if (/^\r?\n$/u.test(code)) return "";
    return ({ b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", s: " " } as Record<string, string>)[code] ?? code;
  });
}

// A text block: the lines after the opening delimiter, the indentation shared by every non-blank line (and
// the closing delimiter's line) removed, trailing spaces removed, then escapes.
function textBlock(raw: string): string {
  const inner = raw.slice(3, -3).replace(/^[ \t\f]*\r?\n/u, "");
  const lines = inner.split(/\r?\n/u);
  const closing = lines.length > 0 && lines[lines.length - 1]!.trim() === "";
  const indented = lines.filter((line, index) => line.trim() !== "" || (closing && index === lines.length - 1));
  const indent = indented.length === 0 ? 0 : Math.min(...indented.map((line) => /^[ \t]*/u.exec(line)![0].length));
  return unescape(lines.map((line) => line.slice(Math.min(indent, /^[ \t]*/u.exec(line)![0].length)).replace(/[ \t]+$/u, "")).join("\n"));
}

/** The value of a Java string literal as written (`"a\n"` or a text block); null for anything else. */
export function javaStringLiteralValue(literal: string): string | null {
  if (literal.startsWith('"""') && literal.endsWith('"""') && literal.length >= 6) return textBlock(literal);
  if (/^"(?:[^"\\\n]|\\.)*"$/su.test(literal)) return unescape(literal.slice(1, -1));
  return null;
}

// ---------------------------------------------------------------- parse time

export type JavaStringScope = {
  /** Single-assignment locals of the method (`readLocalStrings`). */
  locals?: ReadonlyMap<string, JavaStringTemplate>;
};

const dynamic = (node: SyntaxNode): JavaStringTemplate => [{ expr: compactExpression(node.text) }];

function unwrap(node: SyntaxNode): SyntaxNode {
  let current = node;
  while ((current.type === "parenthesized_expression" || current.type === "cast_expression") && current.namedChildren.length > 0) {
    const inner = current.type === "cast_expression" ? current.childForFieldName("value") : current.namedChildren.find((child) => !isComment(child));
    if (!inner) break;
    current = inner;
  }
  return current;
}

// `a + b + c` (left-nested) as [a, b, c]; anything else is one operand.
function operandsOf(node: SyntaxNode): SyntaxNode[] {
  const operands: SyntaxNode[] = [];
  let current = node;
  while (current.type === "binary_expression" && current.childForFieldName("operator")?.text === "+") {
    const right = current.childForFieldName("right");
    const left = current.childForFieldName("left");
    if (!right || !left) break;
    operands.push(right);
    current = left;
  }
  operands.push(current);
  return operands.reverse();
}

const argumentsOf = (call: SyntaxNode): SyntaxNode[] => call.childForFieldName("arguments")?.namedChildren.filter((child) => !isComment(child)) ?? [];

const FORMAT_SPEC = /%(?:(\d+)\$)?[-#+ 0,(<]*\d*(?:\.\d+)?([a-zA-Z%])/gu;

// `String.format(fmt, …)` with a literal `fmt`: the format's text with each conversion replaced by its argument.
function formatted(format: string, args: readonly JavaStringTemplate[]): JavaStringTemplate {
  const parts: JavaStringTemplate = [];
  let last = 0;
  let next = 0;
  for (const match of format.matchAll(FORMAT_SPEC)) {
    parts.push({ text: format.slice(last, match.index) });
    last = match.index + match[0].length;
    const conversion = match[2]!;
    if (conversion === "%") parts.push({ text: "%" });
    else if (conversion === "n") parts.push({ text: "\n" });
    else {
      const index = match[1] ? Number(match[1]) - 1 : next++;
      parts.push(...(args[index] ?? [{ expr: `arg${index}` }]));
    }
  }
  parts.push({ text: format.slice(last) });
  return parts;
}

function partsOfCall(node: SyntaxNode, scope: JavaStringScope): JavaStringTemplate {
  const name = node.childForFieldName("name")?.text;
  const object = node.childForFieldName("object");
  const args = argumentsOf(node);
  const objectText = object ? compactExpression(object.text) : "";
  const read = (argument: SyntaxNode) => partsOf(argument, scope);
  const staticOn = (...owners: string[]) => owners.some((owner) => objectText === owner || objectText === `java.lang.${owner}`);
  if (name === "format" && staticOn("String") && args.length >= 1) {
    const format = partsOf(args[0]!, scope);
    if (format.length === 1 && "text" in format[0]!) return formatted(format[0].text, args.slice(1).map(read));
    return dynamic(node);
  }
  if (name === "formatted" && object) {
    const format = partsOf(object, scope);
    if (format.length === 1 && "text" in format[0]!) return formatted(format[0].text, args.map(read));
    return dynamic(node);
  }
  if (name === "valueOf" && staticOn("String") && args.length === 1) return read(args[0]!);
  if (name === "toString" && args.length === 1 && (staticOn("Objects", "Integer", "Long"))) return read(args[0]!);
  if (object && args.length === 0 && name && PASS_THROUGH.has(name)) return partsOf(object, scope);
  if (name === "concat" && object && args.length === 1) return [...partsOf(object, scope), ...read(args[0]!)];
  if (name === "join" && staticOn("String") && args.length >= 2) {
    const separator = partsOf(args[0]!, scope);
    if (separator.length === 1 && "text" in separator[0]!) {
      return args.slice(1).flatMap((argument, index) => [...(index > 0 ? separator : []), ...read(argument)]);
    }
  }
  return dynamic(node);
}

function partsOf(raw: SyntaxNode, scope: JavaStringScope): JavaStringTemplate {
  const node = unwrap(raw);
  const operands = operandsOf(node);
  if (operands.length > 1) return tidy(operands.flatMap((operand) => partsOf(operand, scope)));
  switch (node.type) {
    case "string_literal": {
      const value = javaStringLiteralValue(node.text);
      return value === null ? dynamic(node) : [{ text: value }];
    }
    case "character_literal":
      return [{ text: unescape(node.text.slice(1, -1)) }];
    case "decimal_integer_literal":
      return [{ text: node.text.replace(/_/gu, "").replace(/[lL]$/u, "") }];
    case "identifier":
      return scope.locals?.get(node.text) ?? [{ ref: node.text }];
    case "field_access":
    case "scoped_identifier": {
      const name = dottedName(node);
      return name ? [{ ref: name.replace(/^this\./u, "") }] : dynamic(node);
    }
    case "method_invocation":
      return partsOfCall(node, scope);
    default:
      return dynamic(node);
  }
}

/** The template of a string expression; null when it holds no literal text and no name that could be a constant. */
export function readJavaString(node: SyntaxNode, scope: JavaStringScope = {}): JavaStringTemplate | null {
  const template = tidy(partsOf(node, scope));
  return template.some((part) => "text" in part || "ref" in part) ? template : null;
}

// A local assigned more than once (or declared twice) is not a constant.
function assignedNames(roots: readonly SyntaxNode[]): { declared: Map<string, SyntaxNode[]>; assigned: Set<string> } {
  const declared = new Map<string, SyntaxNode[]>();
  const assigned = new Set<string>();
  const stack: SyntaxNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "local_variable_declaration") {
      for (const declarator of node.childrenForFieldName("declarator")) {
        const name = declarator.childForFieldName("name")?.text;
        const value = declarator.childForFieldName("value");
        if (name) declared.set(name, [...declared.get(name) ?? [], ...(value ? [value] : [])]);
      }
    } else if (node.type === "assignment_expression" || node.type === "update_expression") {
      const target = node.childForFieldName("left") ?? node.namedChildren[0];
      if (target?.type === "identifier") assigned.add(target.text);
    } else if (node.type === "lambda_expression" || node.type === "formal_parameter" || node.type === "enhanced_for_statement" || node.type === "catch_formal_parameter") {
      const name = node.childForFieldName("name")?.text;
      if (name) assigned.add(name);
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return { declared, assigned };
}

/**
 * The locals of a method body that are declared once with a value and never assigned again, by template
 * (`String url = BASE + "/users/" + id;`), in declaration order so a local may use an earlier one.
 */
export function readLocalStrings(roots: readonly SyntaxNode[]): Map<string, JavaStringTemplate> {
  const { declared, assigned } = assignedNames(roots);
  const locals = new Map<string, JavaStringTemplate>();
  const declarations: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "local_variable_declaration") declarations.push(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  for (const declaration of declarations) {
    const type = normalizeJavaType(typeText(declaration.childForFieldName("type")));
    const typed = type === null ? typeText(declaration.childForFieldName("type")) === "var" : CONSTANT_TYPES.has(type);
    if (!typed) continue;
    for (const declarator of declaration.childrenForFieldName("declarator")) {
      const name = declarator.childForFieldName("name")?.text;
      const value = declarator.childForFieldName("value");
      if (!name || !value || assigned.has(name) || (declared.get(name)?.length ?? 0) !== 1) continue;
      const template = readJavaString(value, { locals });
      if (template && hasLiteralText(template)) locals.set(name, template);
    }
  }
  return locals;
}

// ---------------------------------------------------------------- text form (annotation arguments)

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/**
 * The template of a string expression kept as text, such as an annotation argument as the parser stores
 * it (`"/api/" + Paths.USERS`, `Urls.BASE`): literals, `+`, parentheses, dotted names as `ref`, anything
 * else `expr`. Null when it holds no literal text and no name.
 */
export function javaStringFromText(expression: string): JavaStringTemplate | null {
  const trimmed = expression.trim();
  const template = tidy(splitTopLevel(trimmed, "+").flatMap((operand): JavaStringTemplate => {
    const literal = javaStringLiteralValue(operand);
    if (literal !== null) return [{ text: literal }];
    if (operand.startsWith("(") && operand.endsWith(")")) return javaStringFromText(operand.slice(1, -1)) ?? [{ expr: operand }];
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(operand)) return [{ ref: operand.replace(/^this\./u, "") }];
    return [{ expr: operand }];
  }));
  return template.some((part) => "text" in part || "ref" in part) ? template : null;
}

// ---------------------------------------------------------------- constants (parse plugin)

/**
 * Keeps the template of each `final` String/int/long/char field with an initializer on its Field node as
 * `stringConstant` (JSON), for `createJavaStringResolver`. Interface fields are constants too.
 */
const readConstants: JavaParsePlugin = ({ fileNodeId, root, nodes }) => {
  const fields = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.label === "Field" && node.id.startsWith(`${fileNodeId}:`)) fields.set(`${node.properties.line}:${node.properties.name}`, node);
  }
  if (fields.size === 0) return;
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "field_declaration" || node.type === "constant_declaration") {
      const inInterface = node.parent?.type === "interface_body" || node.parent?.type === "annotation_type_body";
      const type = normalizeJavaType(typeText(node.childForFieldName("type")));
      if ((inInterface || node.type === "constant_declaration" || modifiersOf(node).words.has("final")) && type && CONSTANT_TYPES.has(type)) {
        for (const declarator of node.childrenForFieldName("declarator")) {
          const name = declarator.childForFieldName("name")?.text;
          const value = declarator.childForFieldName("value");
          if (!name || !value) continue;
          const field = fields.get(`${declarator.startPosition.row + 1}:${name}`);
          const template = field ? readJavaString(value) : null;
          if (field && template) field.properties.stringConstant = serializeJavaString(template);
        }
      }
      continue;
    }
    // Members live in type bodies; method and initializer bodies hold none that matter.
    if (node.type === "block" || node.type === "constructor_body") continue;
    for (const child of node.namedChildren) stack.push(child);
  }
};

export const javaStringConstantsPlugin: JavaParsePlugin & { version: string } = Object.assign(readConstants, { version: "1" });

// ---------------------------------------------------------------- resolution

export type JavaStringResolver = {
  /** `ref` parts replaced by the constants they name (or kept when unknown). */
  resolveParts(template: JavaStringTemplate, scope: TypeScope): JavaStringTemplate;
  /** The template as a string (`${expression}` for what is unknown); null when no literal text is known. */
  resolve(template: JavaStringTemplate, scope: TypeScope): string | null;
  /** The constant `name` (`NAME`, `Type.NAME`, `pkg.Type.NAME`) names when written in `scope`, as a template. */
  constant(name: string, scope: TypeScope): JavaStringTemplate | null;
};

const resolvers = new WeakMap<object, JavaStringResolver>();

export function createJavaStringResolver(graph: IGraphContributor): JavaStringResolver {
  const known = resolvers.get(graph);
  if (known) return known;
  const created = build(graph);
  resolvers.set(graph, created);
  return created;
}

function build(graph: IGraphContributor): JavaStringResolver {
  const index = createResolutionRelationshipIndex(graph);
  const types: JavaTypeIndex = createJavaTypeIndex(graph, index);

  const constantsByType = new Map<string, Map<string, JavaStringTemplate>>();
  for (const type of ["DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"] as const) {
    for (const relationship of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const field = graph.node(relationship.to);
      const template = parseJavaString(field?.properties.stringConstant);
      if (!field || !template) continue;
      const own = constantsByType.get(relationship.from) ?? new Map<string, JavaStringTemplate>();
      own.set(String(field.properties.name), template);
      constantsByType.set(relationship.from, own);
    }
  }
  // `import static a.b.C.NAME;` and `import static a.b.C.*;` by file.
  const staticImports = new Map<string, Array<{ source: string; wildcard: boolean }>>();
  for (const relationship of graph.relationshipsOfType("IMPORTS")) {
    const node = graph.node(relationship.to);
    if (node?.properties.isStatic !== true) continue;
    const list = staticImports.get(relationship.from) ?? [];
    list.push({ source: String(node.properties.source ?? ""), wildcard: node.properties.isWildcard === true });
    staticImports.set(relationship.from, list);
  }

  // The constant `name` of `type` or of its supertypes.
  const inType = (type: JavaType, name: string, seen = new Set<string>()): { template: JavaStringTemplate; owner: JavaType } | null => {
    if (seen.has(type.id)) return null;
    seen.add(type.id);
    const own = constantsByType.get(type.id)?.get(name);
    if (own) return { template: own, owner: type };
    for (const parent of types.supertypes(type)) {
      const found = inType(parent, name, seen);
      if (found) return found;
    }
    return null;
  };

  const lookup = (name: string, scope: TypeScope): { template: JavaStringTemplate; owner: JavaType } | null => {
    const dot = name.lastIndexOf(".");
    if (dot !== -1) {
      const owner = types.resolve(name.slice(0, dot), scope) ?? types.byQualifiedName(name.slice(0, dot), scope.fileId);
      return owner ? inType(owner, name.slice(dot + 1)) : null;
    }
    for (let current = scope.typeId ? types.byId.get(scope.typeId) ?? null : null; current; current = types.enclosing(current)) {
      const found = inType(current, name);
      if (found) return found;
    }
    for (const entry of staticImports.get(scope.fileId) ?? []) {
      if (!entry.wildcard && entry.source.split(".").at(-1) !== name) continue;
      const owner = types.byQualifiedName(entry.wildcard ? entry.source : entry.source.slice(0, entry.source.lastIndexOf(".")), scope.fileId);
      const found = owner ? inType(owner, name) : null;
      if (found) return found;
    }
    return null;
  };

  const resolveParts = (template: JavaStringTemplate, scope: TypeScope, depth: number, seen: ReadonlySet<string>): JavaStringTemplate => {
    const parts: JavaStringTemplate = [];
    for (const part of template) {
      if (!("ref" in part)) {
        parts.push(part);
        continue;
      }
      const found = depth < MAX_DEPTH ? lookup(part.ref, scope) : null;
      const key = found ? `${found.owner.id}\0${part.ref}` : "";
      if (!found || seen.has(key)) {
        parts.push(part);
        continue;
      }
      parts.push(...resolveParts(found.template, { fileId: found.owner.fileId, typeId: found.owner.id }, depth + 1, new Set([...seen, key])));
    }
    return tidy(parts);
  };

  return {
    resolveParts: (template, scope) => resolveParts(template, scope, 0, new Set()),
    resolve(template, scope) {
      const parts = resolveParts(template, scope, 0, new Set());
      return hasLiteralText(parts) ? renderJavaString(parts) : null;
    },
    constant(name, scope) {
      const found = lookup(name, scope);
      return found ? resolveParts(found.template, { fileId: found.owner.fileId, typeId: found.owner.id }, 1, new Set()) : null;
    },
  };
}
