import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import { usingsInScope } from "../../languages/csharp/namespaces.js";
import { declaratorValue } from "../../languages/csharp/calls.js";
import { modifiersOf, nameText, normalizeCSharpType, typeText } from "../../languages/csharp/syntax.js";
import type { CSharpType, CSharpTypeScope } from "../../languages/csharp/types.js";
import { sharedCSharpTypeResolver } from "./receivers.js";

// C# string expressions as templates: what a SQL statement, a URL, a config key or an environment variable name
// is, as far as the code says. Shared by the data (EF Core, Dapper, ADO.NET), config and HTTP tracks, as Java's
// `strings.ts` is for its readers.
//
// A template is a list of parts: literal `{text}`, a dynamic `{expr}` (a parameter, a call, anything unknown) and a
// `{ref}` (a name that may be a constant: `Table`, `Tables.Users`, `App.Db.Tables.Users`). It is plain JSON, so a
// parse plugin keeps one on a node property and a contributor resolves it once every file is parsed.
//
// One reader, `csharpStringFromText`, works on the text of an expression, so the parse time (`readCSharpString` on a
// syntax node) and the graph time (an attribute or constant argument kept as text) agree. It reads, left to right:
//   - regular `"a\n"`, verbatim `@"a""b"`, raw `"""..."""` (incidental indentation removed, any number of quotes) and
//     interpolated `$"a{b}"`, `$@"..."`, `@$"..."`, `$$"""..."""` strings (a hole is the template of its expression,
//     its alignment and format dropped; `{{` and `}}` are braces); `+` concatenation at any depth, parentheses, a
//     `(string)` cast, a trailing `!`;
//   - `nameof(a.B)` (the text `B`), `string.Format("{0}/{1}", a, b)`, `string.Concat(a, b)`,
//     `string.Join("/", a, b)` with a literal separator and several values; `.ToString()`, `.Trim()`, `.TrimStart()`
//     and `.TrimEnd()` of a known text;
//   - a single-assignment local of the member (`readLocalStrings`: `var sql = "select " + cols;` never assigned
//     again, `+=` counts as assigned) by its value; a parameter or any other local (assigned twice, a loop variable,
//     a lambda parameter, from a call) is an `expr` when the scope names it in `dynamic`, even when a constant has its
//     name; any other name is a `ref`; anything else an `expr`.
// A `const` or `readonly` field of string (or int, long, char...) with an initializer keeps its template on the Field
// node as the private property `csharpStringConstant`, written by `csharpStringConstantsPlugin`, which also reads
// get-only properties with an initializer or an expression body (`public static string Table => "users";`).
// `csharpStringsContributor` removes the property once every C# data, config and HTTP contributor has run (it is a
// parse-to-graph fact, not a graph property: the goldens never show it).
//
// Resolution (`createCSharpStringResolver`, after every file is parsed) replaces a `ref` by the constant it names: a
// field of the enclosing types (and their scanned supertypes), a name brought in by `using static`, or `Type.NAME` /
// `Ns.Type.NAME` of another file (a constant that refers to another constant is followed; a cycle or eight levels stop it).
// A name that is no scanned constant stays dynamic. A dynamic part is `${expression}` in a rendered string, the
// convention of the other languages' HTTP clients (characters that would split a URL become `_`).
//
// Not handled: a constant built by a method call, `StringBuilder`, `string.Create`, switch and ternary values (`expr`),
// `FormattableString` and `FromSqlInterpolated` semantics beyond the holes.

export type CSharpStringPart = { text: string } | { expr: string } | { ref: string };
export type CSharpStringTemplate = CSharpStringPart[];

const MAX_DEPTH = 8;
const CONSTANT_PROPERTY = "csharpStringConstant";
const CONSTANT_TYPES = new Set(["string", "String", "System.String", "int", "long", "short", "char", "uint", "ulong", "bool", "Int32", "Int64"]);

// ---------------------------------------------------------------- templates

export const hasLiteralText = (template: CSharpStringTemplate): boolean => template.some((part) => "text" in part && part.text !== "");

export const serializeCSharpString = (template: CSharpStringTemplate): string => JSON.stringify(template);

export function parseCSharpString(value: unknown): CSharpStringTemplate | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as CSharpStringTemplate) : null;
  } catch {
    return null;
  }
}

/** Adjacent texts merged, empty ones dropped. */
export function tidy(parts: CSharpStringTemplate): CSharpStringTemplate {
  const result: CSharpStringTemplate = [];
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
export const renderCSharpString = (template: CSharpStringTemplate): string => template.map((part) => ("text" in part ? part.text : placeholder("expr" in part ? part.expr : part.ref))).join("");

/** The text of a template that is all literal (a key, a table, a path), else null. */
export const literalText = (template: CSharpStringTemplate | null | undefined): string | null =>
  template && template.length > 0 && template.every((part) => "text" in part) && hasLiteralText(template) ? template.map((part) => ("text" in part ? part.text : "")).join("") : null;

// ---------------------------------------------------------------- literals

function unescapeCSharp(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|[0abtnfvr"'\\])/gu, (_, code: string) => {
    if (code.startsWith("u") || code.startsWith("x") || code.startsWith("U")) return String.fromCodePoint(parseInt(code.slice(1), 16));
    return ({ "0": "\0", a: "\x07", b: "\b", t: "\t", n: "\n", f: "\f", v: "\v", r: "\r" } as Record<string, string>)[code] ?? code;
  });
}

type Segment = { text: string } | { hole: string };
type Lexed = { end: number; segments: Segment[] };

// Where a `{` hole of an interpolated string ends: the index of its closing `}` and the expression text (alignment
// `,n` and format `:f` dropped). Nested strings and characters, brackets and parentheses are skipped.
function lexHole(text: string, from: number): { close: number; expression: string } | null {
  let depth = 0;
  let expressionEnd = -1;
  for (let i = from; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '"' || char === "$" || char === "@") {
      const nested = lexString(text, i);
      if (nested) {
        i = nested.end - 1;
        continue;
      }
    }
    if (char === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'") j += text[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "}") {
      if (depth === 0) return { close: i, expression: text.slice(from, expressionEnd === -1 ? i : expressionEnd).trim() };
      depth -= 1;
    } else if (depth === 0 && expressionEnd === -1 && (char === "," || (char === ":" && text[i + 1] !== ":" && text[i - 1] !== ":"))) expressionEnd = i;
  }
  return null;
}

// Reads the string literal that starts at `start` (any prefix: `$`, `@`, `$@`, `@$`, `$$`; regular, verbatim, raw), or null.
function lexString(text: string, start: number): Lexed | null {
  let i = start;
  let dollars = 0;
  let verbatim = false;
  while (text[i] === "$" || text[i] === "@") {
    if (text[i] === "$") dollars += 1;
    else verbatim = true;
    i += 1;
  }
  if (text[i] !== '"') return null;
  let quotes = 0;
  while (text[i + quotes] === '"') quotes += 1;
  const segments: Segment[] = [];
  if (quotes >= 3 && !verbatim) return lexRaw(text, i, quotes, dollars);
  if (quotes === 2 && !verbatim) return { end: i + 2, segments: [] };
  i += 1;
  let buffer = "";
  const flush = (): void => {
    if (buffer !== "") segments.push({ text: buffer });
    buffer = "";
  };
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"') {
      if (verbatim && text[i + 1] === '"') {
        buffer += '"';
        i += 2;
        continue;
      }
      flush();
      return { end: i + 1, segments };
    }
    if (!verbatim && char === "\\") {
      const escape = /^\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|.)/su.exec(text.slice(i, i + 10))![0];
      buffer += unescapeCSharp(escape);
      i += escape.length;
      continue;
    }
    if (dollars > 0 && char === "{") {
      if (text[i + 1] === "{") {
        buffer += "{";
        i += 2;
        continue;
      }
      const hole = lexHole(text, i + 1);
      if (!hole) return null;
      flush();
      segments.push({ hole: hole.expression });
      i = hole.close + 1;
      continue;
    }
    if (dollars > 0 && char === "}" && text[i + 1] === "}") {
      buffer += "}";
      i += 2;
      continue;
    }
    buffer += char;
    i += 1;
  }
  return null;
}

// A raw string: `quotes` (3 or more) quotes open and close it; with `$`s a hole is `$`-count braces. A multi-line one
// drops the first and last line and the closing line's indentation from every line.
function lexRaw(text: string, quoteStart: number, quotes: number, dollars: number): Lexed | null {
  const delimiter = '"'.repeat(quotes);
  const bodyStart = quoteStart + quotes;
  // Find the closing delimiter outside holes.
  const holes: string[] = [];
  let masked = "";
  let i = bodyStart;
  while (i < text.length) {
    if (text.startsWith(delimiter, i) && text[i + quotes] !== '"') break;
    if (dollars > 0 && text[i] === "{") {
      let run = 0;
      while (text[i + run] === "{") run += 1;
      if (run >= dollars) {
        // The last `dollars` braces open the hole; the braces before them are text.
        masked += "{".repeat(run - dollars);
        const hole = lexHole(text, i + run);
        if (!hole) return null;
        holes.push(hole.expression);
        masked += "\uE000";
        i = hole.close + 1;
        // The closing braces: `dollars` of them (one was consumed by lexHole).
        i += dollars - 1;
        continue;
      }
      masked += "{".repeat(run);
      i += run;
      continue;
    }
    masked += text[i];
    i += 1;
  }
  if (i >= text.length) return null;
  let body = masked;
  if (/^[ \t]*\r?\n/u.test(body)) {
    const lines = body.split(/\r?\n/u);
    lines.shift();
    const last = lines.pop() ?? "";
    const indent = /^[ \t]*/u.exec(last)![0];
    body = lines.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart())).join("\n");
  }
  const segments: Segment[] = [];
  let hole = 0;
  for (const piece of body.split("\uE000")) {
    if (piece !== "") segments.push({ text: piece });
    if (hole < holes.length) segments.push({ hole: holes[hole++]! });
  }
  return { end: i + quotes, segments };
}

/**
 * The value of one C# string literal (`"a"`, `@"a""b"`, `"""raw"""`) as written, nothing else (no `+`, no
 * interpolation); null for anything else.
 */
export function csharpStringLiteralValue(literal: string): string | null {
  const text = literal.trim();
  const lexed = lexString(text, 0);
  if (!lexed || lexed.end !== text.length || lexed.segments.some((segment) => "hole" in segment)) return null;
  return lexed.segments.map((segment) => ("text" in segment ? segment.text : "")).join("");
}

// ---------------------------------------------------------------- reading expressions

export type CSharpStringScope = {
  /** Single-assignment locals of the member (`readLocalStrings`). */
  locals?: ReadonlyMap<string, CSharpStringTemplate>;
  /** Names the member declares (parameters and locals): `expr`, never a constant, whatever the fields are called. */
  dynamic?: ReadonlySet<string>;
};

// Splits at `separator` outside strings, characters and brackets.
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '"' || char === "$" || char === "@") {
      const lexed = lexString(text, i);
      if (lexed) {
        i = lexed.end - 1;
        continue;
      }
    }
    if (char === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'") j += text[j] === "\\" ? 2 : 1;
      i = j;
    } else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

// True when `text` is `( ... )` as a whole.
function wholeParenthesized(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '"' || char === "$" || char === "@") {
      const lexed = lexString(text, i);
      if (lexed) {
        i = lexed.end - 1;
        continue;
      }
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0 && i < text.length - 1) return false;
    }
  }
  return depth === 0;
}

const IDENTIFIER = /^@?[A-Za-z_][\w]*$/u;
const DOTTED = /^(?:global::)?@?[A-Za-z_]\w*(?:\.@?[A-Za-z_]\w*)+$/u;
const PASS_THROUGH = /^([\s\S]+)\.(?:ToString|Trim|TrimStart|TrimEnd)\(\)$/u;

function operandParts(raw: string, scope: CSharpStringScope, depth: number): CSharpStringTemplate {
  let operand = raw.trim();
  if (operand.endsWith("!") && !operand.endsWith("!=")) operand = operand.slice(0, -1).trim();
  if (operand === "") return [];
  const lexed = lexString(operand, 0);
  if (lexed && lexed.end === operand.length) {
    return lexed.segments.flatMap((segment): CSharpStringTemplate => ("text" in segment ? [{ text: segment.text }] : holeParts(segment.hole, scope, depth)));
  }
  if (wholeParenthesized(operand)) {
    const inner = operand.slice(1, -1);
    return depth > MAX_DEPTH ? [{ expr: operand }] : tidy(splitTopLevel(inner, "+").flatMap((part) => operandParts(part, scope, depth + 1)));
  }
  const cast = /^\(\s*(?:string|object)\s*\)\s*([\s\S]+)$/u.exec(operand);
  if (cast) return operandParts(cast[1]!, scope, depth + 1);
  const nameOf = /^nameof\(\s*([\w.@:]+)\s*\)$/u.exec(operand);
  if (nameOf) return [{ text: nameOf[1]!.replace(/^@/u, "").split(".").at(-1)! }];
  const call = /^(?:string|String|System\.String)\.(Format|Concat|Join)\(([\s\S]*)\)$/u.exec(operand);
  if (call) return callParts(call[1]!, splitTopLevel(call[2]!, ","), scope, depth, operand);
  const pass = PASS_THROUGH.exec(operand);
  if (pass && depth <= MAX_DEPTH) return operandParts(pass[1]!, scope, depth + 1);
  if (IDENTIFIER.test(operand)) {
    const name = operand.replace(/^@/u, "");
    const local = scope.locals?.get(name);
    if (local) return local;
    return scope.dynamic?.has(name) ? [{ expr: name }] : [{ ref: name }];
  }
  if (DOTTED.test(operand)) {
    const name = operand.replace(/^global::/u, "").replace(/@/gu, "").replace(/^this\./u, "");
    const first = name.split(".")[0]!;
    return scope.locals?.has(first) || scope.dynamic?.has(first) ? [{ expr: name }] : [{ ref: name }];
  }
  return [{ expr: operand }];
}

function holeParts(expression: string, scope: CSharpStringScope, depth: number): CSharpStringTemplate {
  if (depth > MAX_DEPTH) return [{ expr: expression }];
  const parts = splitTopLevel(expression, "+").flatMap((part) => operandParts(part, scope, depth + 1));
  return parts.length === 0 ? [{ expr: expression }] : parts;
}

function callParts(name: string, args: string[], scope: CSharpStringScope, depth: number, whole: string): CSharpStringTemplate {
  const parts = (text: string): CSharpStringTemplate => holeParts(text, scope, depth + 1);
  if (name === "Concat") return args.length === 0 ? [{ expr: whole }] : args.flatMap(parts);
  if (name === "Join") {
    const separator = args[0] === undefined ? null : csharpStringLiteralValue(args[0]);
    if (separator === null || args.length < 3) return [{ expr: whole }];
    return args.slice(1).flatMap((arg, index) => [...(index === 0 ? [] : [{ text: separator }]), ...parts(arg)]);
  }
  // Format: a literal format string, `{n[,align][:format]}` and `{{` `}}`.
  const format = args[0] === undefined ? null : csharpStringLiteralValue(args[0]);
  if (format === null) return [{ expr: whole }];
  const values = args.slice(1);
  const result: CSharpStringTemplate = [];
  const pattern = /\{\{|\}\}|\{(\d+)(?:,[^:}]*)?(?::[^}]*)?\}/gu;
  let last = 0;
  for (const match of format.matchAll(pattern)) {
    result.push({ text: format.slice(last, match.index) });
    if (match[1] === undefined) result.push({ text: match[0][0]! });
    else {
      const value = values[Number(match[1])];
      result.push(...(value === undefined ? [{ expr: whole }] : parts(value)));
    }
    last = match.index + match[0].length;
  }
  result.push({ text: format.slice(last) });
  return result;
}

/**
 * The template of a string expression given as text (an attribute argument, a constant's initializer, a call
 * argument's text); null when it holds no literal text and no name that could be a constant.
 */
export function csharpStringFromText(expression: string, scope: CSharpStringScope = {}): CSharpStringTemplate | null {
  const template = tidy(splitTopLevel(expression.trim(), "+").flatMap((part) => operandParts(part, scope, 0)));
  // A plain name (a parameter, a local) still counts as a name: `id + n` is `${id}${n}`.
  return template.some((part) => "text" in part || "ref" in part || IDENTIFIER.test(part.expr)) ? template : null;
}

/** `csharpStringFromText` of a syntax node (an argument value, an initializer). */
export const readCSharpString = (node: SyntaxNode, scope: CSharpStringScope = {}): CSharpStringTemplate | null => csharpStringFromText(node.text, scope);

// ---------------------------------------------------------------- locals of a member

// Locals declared once with a value and never assigned again (`=` of another value, `+=`, `++`, `out`/`ref` use, a
// second declaration of the name anywhere in the member, a lambda or foreach variable of that name).
function assignedNames(roots: readonly SyntaxNode[]): { declared: Map<string, number>; assigned: Set<string> } {
  const declared = new Map<string, number>();
  const assigned = new Set<string>();
  const stack: SyntaxNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "variable_declarator": {
        const name = nameText(node.childForFieldName("name"));
        if (name) declared.set(name, (declared.get(name) ?? 0) + 1);
        break;
      }
      case "assignment_expression": {
        const target = node.childForFieldName("left") ?? node.namedChildren[0];
        if (target?.type === "identifier") assigned.add(target.text);
        break;
      }
      case "prefix_unary_expression":
      case "postfix_unary_expression": {
        const target = node.namedChildren[0];
        if (target?.type === "identifier" && /(?:\+\+|--)/u.test(node.text)) assigned.add(target.text);
        break;
      }
      case "argument": {
        // `out var x` / `ref x`
        if (/^(?:ref|out)\b/u.test(node.text)) {
          const target = node.namedChildren.find((child) => child.type === "identifier");
          if (target) assigned.add(target.text);
        }
        break;
      }
      case "parameter":
      case "foreach_statement":
      case "catch_declaration":
      case "declaration_expression": {
        const name = nameText(node.childForFieldName("name") ?? node.childForFieldName("left"));
        if (name) assigned.add(name);
        break;
      }
      default:
        break;
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return { declared, assigned };
}

/**
 * The locals of a member (`roots`: the member's declaration or body) that hold a string known at the declaration, by
 * template (`var sql = "select * from " + Tables.Users;`), in declaration order so a local may use an earlier one.
 * `dynamic`: the names the member declares (use `localNamesOf`), which stay `expr`.
 */
export function readLocalStrings(roots: readonly SyntaxNode[], dynamic?: ReadonlySet<string>): Map<string, CSharpStringTemplate> {
  const { declared, assigned } = assignedNames(roots);
  const locals = new Map<string, CSharpStringTemplate>();
  const declarations: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "variable_declaration" && node.parent?.type !== "field_declaration") declarations.push(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
  for (const declaration of declarations) {
    const written = typeText(declaration.childForFieldName("type"));
    const type = normalizeCSharpType(written);
    if (written !== "var" && !(type !== null && CONSTANT_TYPES.has(type))) continue;
    for (const declarator of declaration.namedChildren.filter((child) => child.type === "variable_declarator")) {
      const name = nameText(declarator.childForFieldName("name"));
      const value = declaratorValue(declarator);
      if (!name || !value || assigned.has(name) || declared.get(name) !== 1) continue;
      const template = readCSharpString(value, { locals, ...(dynamic ? { dynamic } : {}) });
      if (template && hasLiteralText(template)) locals.set(name, template);
    }
  }
  return locals;
}

/** The names a Function declares (parameters and locals, from its `csharpLocals` property); the `dynamic` of a scope. */
export function localNamesOf(fn: GraphNode): Set<string> {
  try {
    const parsed: unknown = JSON.parse(String(fn.properties.csharpLocals ?? "{}"));
    return new Set(parsed && typeof parsed === "object" ? Object.keys(parsed) : []);
  } catch {
    return new Set();
  }
}

/**
 * The scope for reading the string arguments of the calls inside one parsed member: its single-assignment string
 * locals and the names it declares. `member.syntax` is the declaration (a method, constructor, accessor, the
 * compilation unit of top-level statements); `member.node` its Function node.
 */
export function stringScopeOf(member: { syntax: SyntaxNode; node: GraphNode }): Required<CSharpStringScope> {
  const dynamic = localNamesOf(member.node);
  return { locals: readLocalStrings([member.syntax], dynamic), dynamic };
}

// ---------------------------------------------------------------- constants (parse plugin)

// Fields and get-only properties of the type bodies of a file (not method bodies) as [syntax, name, value] triples.
function constantMembers(root: SyntaxNode): Array<{ line: number; name: string; value: SyntaxNode; typeNode: SyntaxNode | null; allowed: boolean }> {
  const found: Array<{ line: number; name: string; value: SyntaxNode; typeNode: SyntaxNode | null; allowed: boolean }> = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "field_declaration") {
      const { words } = modifiersOf(node);
      const declaration = node.namedChildren.find((child) => child.type === "variable_declaration");
      const typeNode = declaration?.childForFieldName("type") ?? null;
      for (const declarator of declaration?.namedChildren.filter((child) => child.type === "variable_declarator") ?? []) {
        const name = nameText(declarator.childForFieldName("name"));
        const value = declaratorValue(declarator);
        if (name && value) found.push({ line: declarator.startPosition.row + 1, name, value, typeNode, allowed: words.has("const") || words.has("readonly") });
      }
      continue;
    }
    if (node.type === "property_declaration") {
      const accessors = node.childForFieldName("accessors");
      const hasSetter = accessors?.namedChildren.some((accessor) => accessor.type === "accessor_declaration" && /^\s*(?:(?:private|protected|internal|public)\s+)*(?:set|init)\b/u.test(accessor.text)) ?? false;
      const name = nameText(node.childForFieldName("name"));
      let value = node.childForFieldName("value");
      if (value?.type === "arrow_expression_clause") value = value.namedChildren.find((child) => child.type !== "comment") ?? null;
      if (name && value && !hasSetter) found.push({ line: node.startPosition.row + 1, name, value, typeNode: node.childForFieldName("type"), allowed: true });
      continue;
    }
    if (node.type === "block" || node.type === "arrow_expression_clause") continue;
    for (const child of node.namedChildren) stack.push(child);
  }
  return found;
}

const readConstants: VersionedCSharpParsePlugin = ({ fileNodeId, root, nodes }) => {
  const fields = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.label === "Field" && node.id.startsWith(`${fileNodeId}:field:`)) fields.set(`${node.properties.line}:${node.properties.name}`, node);
  }
  if (fields.size === 0) return;
  for (const member of constantMembers(root)) {
    if (!member.allowed) continue;
    const type = normalizeCSharpType(typeText(member.typeNode));
    if (!type || !CONSTANT_TYPES.has(type)) continue;
    const field = fields.get(`${member.line}:${member.name}`);
    const template = field ? readCSharpString(member.value) : null;
    if (field && template) field.properties[CONSTANT_PROPERTY] = serializeCSharpString(template);
  }
};

/** Removes the private `csharpStringConstant` facts. Registered after the last C# track contributor (`dependsOn` them all). */
export const csharpStringsContributor: ISemanticContributor = {
  id: "csharp.strings",
  dependsOn: ["csharp.data-efcore", "csharp.data-sql", "csharp.config-env", "csharp.http-clients"],
  contribute(graph) {
    for (const field of graph.nodesWithLabel("Field")) delete field.properties[CONSTANT_PROPERTY];
  },
};

/** Keeps the template of each string (or int/long/char) `const`/`readonly` field and get-only property with a value on its Field node as `stringConstant`; goes first in the parser's plugin list. */
export const csharpStringConstantsPlugin: VersionedCSharpParsePlugin = Object.assign(readConstants, { version: "1" });

// ---------------------------------------------------------------- resolution

export type CSharpStringResolver = {
  /** `ref` parts replaced by the constants they name (or kept when unknown), read at `scope`. */
  resolveParts(template: CSharpStringTemplate, scope: CSharpTypeScope): CSharpStringTemplate;
  /** The template as a string (`${expression}` for what is unknown); null when no literal text is known. */
  resolve(template: CSharpStringTemplate, scope: CSharpTypeScope): string | null;
  /** The constant `name` (`NAME`, `Type.NAME`, `Ns.Type.NAME`) names when written at `scope`, as a template. */
  constant(name: string, scope: CSharpTypeScope): CSharpStringTemplate | null;
  /** The scope a Class, Interface, Field, Function, Decorator or Call node is written in (for the methods above). */
  scopeOf(node: GraphNode): CSharpTypeScope | undefined;
  /** `resolveParts` for a Call / Function / Field node's own scope; the template unchanged when its scope is unknown. */
  resolvePartsAt(template: CSharpStringTemplate, node: GraphNode): CSharpStringTemplate;
  /** `resolve` for a node's own scope; null when no literal text is known. */
  resolveAt(template: CSharpStringTemplate, node: GraphNode): string | null;
};

const resolvers = new WeakMap<object, CSharpStringResolver>();

export function createCSharpStringResolver(graph: IGraphContributor): CSharpStringResolver {
  const known = resolvers.get(graph);
  if (known) return known;
  const created = build(graph);
  resolvers.set(graph, created);
  return created;
}

function build(graph: IGraphContributor): CSharpStringResolver {
  const resolver = sharedCSharpTypeResolver(graph);
  const index = resolver.index;
  const constantsByType = new Map<string, Map<string, CSharpStringTemplate>>();
  for (const type of ["DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"] as const) {
    for (const relationship of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const field = graph.node(relationship.to);
      const template = parseCSharpString(field?.properties[CONSTANT_PROPERTY]);
      if (!field || !template) continue;
      let own = constantsByType.get(relationship.from);
      if (!own) constantsByType.set(relationship.from, (own = new Map()));
      own.set(String(field.properties.name), template);
    }
  }

  const inType = (type: CSharpType, name: string, seen = new Set<string>()): { template: CSharpStringTemplate; owner: CSharpType } | null => {
    if (seen.has(type.id)) return null;
    seen.add(type.id);
    const own = constantsByType.get(type.id)?.get(name);
    if (own) return { template: own, owner: type };
    for (const parent of index.supertypes(type)) {
      const found = inType(parent, name, seen);
      if (found) return found;
    }
    return null;
  };

  const lookup = (name: string, scope: CSharpTypeScope): { template: CSharpStringTemplate; owner: CSharpType } | null => {
    const dot = name.lastIndexOf(".");
    if (dot !== -1) {
      const owner = index.resolve(name.slice(0, dot), scope);
      return owner ? inType(owner, name.slice(dot + 1)) : null;
    }
    for (let current = scope.typeId ? index.byId.get(scope.typeId) ?? null : null; current; current = index.enclosing(current)) {
      const found = inType(current, name);
      if (found) return found;
    }
    const usings = usingsInScope(graph, scope.fileId, scope.namespace ?? "", scope.line);
    for (const target of usings.staticTypes) {
      const owner = index.resolve(target, scope);
      const found = owner ? inType(owner, name) : null;
      if (found) return found;
    }
    return null;
  };

  const scopeOfType = (owner: CSharpType): CSharpTypeScope => ({ fileId: owner.fileIds[0]!, typeId: owner.id, namespace: owner.namespace });

  const resolveParts = (template: CSharpStringTemplate, scope: CSharpTypeScope, depth: number, seen: ReadonlySet<string>): CSharpStringTemplate => {
    const parts: CSharpStringTemplate = [];
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
      parts.push(...resolveParts(found.template, scopeOfType(found.owner), depth + 1, new Set([...seen, key])));
    }
    return tidy(parts);
  };

  const api: CSharpStringResolver = {
    resolveParts: (template, scope) => resolveParts(template, scope, 0, new Set()),
    resolve(template, scope) {
      const parts = resolveParts(template, scope, 0, new Set());
      return hasLiteralText(parts) ? renderCSharpString(parts) : null;
    },
    constant(name, scope) {
      const found = lookup(name, scope);
      return found ? resolveParts(found.template, scopeOfType(found.owner), 1, new Set()) : null;
    },
    scopeOf: (node) => resolver.scopeOf(node),
    resolvePartsAt(template, node) {
      const scope = resolver.scopeOf(node);
      return scope ? resolveParts(template, scope, 0, new Set()) : template;
    },
    resolveAt(template, node) {
      const scope = resolver.scopeOf(node);
      if (!scope) return hasLiteralText(template) ? renderCSharpString(template) : null;
      return api.resolve(template, scope);
    },
  };
  return api;
}
