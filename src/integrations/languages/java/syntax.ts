import type { SyntaxNode } from "../syntax/tree-sitter.js";

// Helpers over the tree-sitter-java syntax tree, shared by the declaration and
// call readers.

export type JavaVisibility = "public" | "protected" | "package" | "private";

// What a name is known to hold: a declared (or `new`-inferred) type, or nothing
// known (`null`: the name is a local, its type is not).
// `fullType` keeps the generic arguments of a declared type (`Optional<Limiter.Listener>`); `lambda` says which
// call a lambda parameter without a declared type is an argument of (its type comes from that call's parameter).
export type JavaLambdaContext = { callee: string; receiver: string | null; arity: number; arg: number; param: number };
export type JavaLocal = { type?: string; fullType?: string; lambda?: JavaLambdaContext };

// `annotations` (only when the parameter has some): `@Qualifier("x")` is { name: "Qualifier", args: [`"x"`] },
// the same name and args as a Decorator node.
export type JavaParameterAnnotation = { name: string; args: string[] };
export type JavaParameter = { name: string; type: string; varargs?: true; annotations?: JavaParameterAnnotation[] };

export const typeDeclarationTypes: ReadonlySet<string> = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

export const compact = (text: string): string => text.replace(/\s+/gu, " ").trim();
export const compactNoSpace = (text: string): string => text.replace(/\s+/gu, "");
// An expression on one line: spaces around dots and inside parentheses go, other runs become one space (`new Helper()`).
export const compactExpression = (text: string): string =>
  text.replace(/\s*\.\s*/gu, ".").replace(/\s*([(),])\s*/gu, "$1").replace(/\s+/gu, " ").trim();

export function modifiersOf(node: SyntaxNode): { words: Set<string>; annotations: SyntaxNode[] } {
  const words = new Set<string>();
  const annotations: SyntaxNode[] = [];
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  for (const child of modifiers?.children ?? []) {
    if (child.type === "marker_annotation" || child.type === "annotation") annotations.push(child);
    else if (!child.isNamed || child.type !== "line_comment") words.add(child.text);
  }
  return { words, annotations };
}

export function visibilityOf(words: ReadonlySet<string>, fallback: JavaVisibility): JavaVisibility {
  if (words.has("public")) return "public";
  if (words.has("protected")) return "protected";
  if (words.has("private")) return "private";
  return fallback;
}

export type JavaAnnotation = { name: string; expression: string; args: string[]; line: number; column: number };

// Removes whitespace outside string and char literals (`path = "a b"` keeps its space).
export function compactOutsideLiterals(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      out += char;
      if (char === "\\" && i + 1 < text.length) out += text[++i]!;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      out += char;
    } else if (!/\s/u.test(char)) out += char;
  }
  return out;
}

// `@Named("x")` is name `Named`, args [`"x"`]; `@Foo(a = 1, b = {2, 3})` is args [`a=1`, `b={2,3}`].
export function annotationOf(node: SyntaxNode): JavaAnnotation {
  const args: string[] = [];
  const list = node.childForFieldName("arguments");
  for (const child of list?.namedChildren ?? []) {
    if (child.type === "line_comment" || child.type === "block_comment") continue;
    if (child.type === "element_value_pair") {
      const key = child.childForFieldName("key")?.text ?? "";
      const value = child.childForFieldName("value")?.text ?? "";
      args.push(`${key}=${compactOutsideLiterals(value)}`);
    } else {
      args.push(child.type === "string_literal" ? child.text : compactOutsideLiterals(child.text));
    }
  }
  return {
    name: compactNoSpace(node.childForFieldName("name")?.text ?? node.text.replace(/^@/u, "")),
    expression: compact(node.text),
    args,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  };
}

// The type as written, on one line: `Map<String, List<T>>`, `int[]`, `String...` is `String...`.
export function typeText(node: SyntaxNode | null | undefined): string {
  return node ? compact(node.text) : "";
}

// `List<String>` -> `List`, `java.util.Map.Entry<K, V>` -> `java.util.Map.Entry`,
// `@Nullable Foo[]` -> `Foo[]`, `final Foo` -> `Foo`. Null for `var` and wildcards
// (their type is not a name). Primitives are kept (`int`): no class has that name.
export function normalizeJavaType(text: string | null | undefined): string | null {
  if (!text) return null;
  let type = text.replace(/@[\p{L}\p{N}_$.]+(?:\s*\([^)]*\))?/gu, " ");
  let depth = 0;
  let stripped = "";
  for (const char of type) {
    if (char === "<") depth += 1;
    else if (char === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) stripped += char;
  }
  type = stripped.replace(/\bfinal\b/gu, " ").replace(/\.\.\./gu, "[]").replace(/\s+/gu, "").trim();
  if (type === "" || type === "var" || type === "?" || type.startsWith("?")) return null;
  return /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*(?:\[\])*$/u.test(type) ? type : null;
}

// `Optional<@Nullable Foo>` as written without annotations and spacing; null when the type has no generic arguments.
export function genericTypeText(text: string | null | undefined): string | null {
  if (!text || !text.includes("<")) return null;
  const type = text.replace(/@[\p{L}\p{N}_$.]+(?:\s*\([^)]*\))?/gu, " ").replace(/\bfinal\b/gu, " ").replace(/\s+/gu, " ").replace(/\s*([<>,.])\s*/gu, "$1").trim();
  return type.includes("<") && !type.startsWith("var") && type.length <= 160 ? type : null;
}

export function lastSegment(name: string): string {
  return name.split(".").at(-1) ?? name;
}

// Type parameters as written: ["T", "K extends Comparable<K>"].
export function typeParametersOf(node: SyntaxNode): string[] {
  const list = node.childForFieldName("type_parameters");
  return list?.namedChildren.filter((child) => child.type === "type_parameter").map((child) => compact(child.text)) ?? [];
}

// `(final int a, String... rest, @Nullable Foo f)` as [{name, type, varargs?, annotations?}].
export function javaParameters(list: SyntaxNode | null | undefined): JavaParameter[] {
  const parameters: JavaParameter[] = [];
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type === "formal_parameter") {
      const name = parameter.childForFieldName("name")?.text;
      if (!name) continue;
      const dimensions = parameter.childForFieldName("dimensions")?.text.replace(/\s+/gu, "") ?? "";
      const annotations = modifiersOf(parameter).annotations.map((annotation) => {
        const { name, args } = annotationOf(annotation);
        return { name, args };
      });
      parameters.push({
        name,
        type: `${typeText(parameter.childForFieldName("type"))}${dimensions}`,
        ...(annotations.length > 0 ? { annotations } : {}),
      });
    } else if (parameter.type === "spread_parameter") {
      const declarator = parameter.namedChildren.find((child) => child.type === "variable_declarator");
      const name = declarator?.childForFieldName("name")?.text;
      const typeNode = parameter.namedChildren.find((child) => child.type !== "modifiers" && child.type !== "variable_declarator" && !child.type.endsWith("comment"));
      if (!name) continue;
      const annotations = modifiersOf(parameter).annotations.map((annotation) => {
        const { name, args } = annotationOf(annotation);
        return { name, args };
      });
      parameters.push({
        name,
        type: `${typeText(typeNode)}[]`,
        varargs: true,
        ...(annotations.length > 0 ? { annotations } : {}),
      });
    }
  }
  return parameters;
}

// Argument expressions of an `argument_list`, comments left out.
export function argumentCount(list: SyntaxNode | null | undefined): number {
  return list?.namedChildren.filter((argument) => !argument.type.endsWith("comment")).length ?? 0;
}

// `a.b.C` from an identifier or a scoped/field-access chain; null for anything else.
export function dottedName(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") return compactNoSpace(node.text);
  if (node.type !== "field_access") return null;
  // Iterative: walk down the `object` chain, then join the fields from the root up.
  const fields: string[] = [];
  let current: SyntaxNode | null = node;
  while (current.type === "field_access") {
    const field: SyntaxNode | null = current.childForFieldName("field");
    if (!field || field.type !== "identifier") return null;
    fields.push(field.text);
    current = current.childForFieldName("object");
    if (!current) return null;
  }
  const base = dottedName(current);
  return base ? [base, ...fields.reverse()].join(".") : null;
}
