import type { SyntaxNode } from "../syntax/tree-sitter.js";

// Helpers over the tree-sitter-c-sharp syntax tree, shared by the declaration and call readers.

export type CSharpVisibility = "public" | "internal" | "protected" | "private" | "protected internal" | "private protected" | "file";

// What a name is known to hold: a declared (or `new`-inferred) type, or nothing known (`null`: the name is
// a local, its type is not). `fullType` keeps the generic arguments (`List<Foo>`).
export type CSharpLocal = { type?: string; fullType?: string };

// `annotations` (only when the parameter has attributes): `[FromBody]` is { name: "FromBody", args: [] }.
export type CSharpParameterAttribute = { name: string; args: string[] };
// `type` is as written (`int[]`, `List<T>`, `ref int` keeps the type only); `modifier` is `ref`, `out`, `in`, `this`
// (the receiver of an extension method) or `readonly ref`; `params` marks `params T[]`; `optional` a default value.
export type CSharpParameter = {
  name: string;
  type: string;
  modifier?: string;
  params?: true;
  optional?: true;
  defaultValue?: string;
  annotations?: CSharpParameterAttribute[];
};

export const typeDeclarationTypes: ReadonlySet<string> = new Set([
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "record_declaration",
  "record_struct_declaration",
  "enum_declaration",
  "delegate_declaration",
]);

export const compact = (text: string): string => text.replace(/\s+/gu, " ").trim();
export const compactNoSpace = (text: string): string => text.replace(/\s+/gu, "");
// An expression on one line: spaces around dots and inside parentheses go, other runs become one space.
export const compactExpression = (text: string): string =>
  text.replace(/\s*\.\s*/gu, ".").replace(/\s*([(),])\s*/gu, "$1").replace(/\s+/gu, " ").trim();

export const isComment = (node: SyntaxNode): boolean => node.type === "comment";

// `modifier` nodes (`public`, `static`, `protected`, `internal`, ...) as words, and the `attribute_list` nodes.
export function modifiersOf(node: SyntaxNode): { words: Set<string>; attributeLists: SyntaxNode[] } {
  const words = new Set<string>();
  const attributeLists: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "modifier") words.add(child.text);
    else if (child.type === "attribute_list") attributeLists.push(child);
  }
  return { words, attributeLists };
}

export function visibilityOf(words: ReadonlySet<string>, fallback: CSharpVisibility): CSharpVisibility {
  if (words.has("file")) return "file";
  if (words.has("public")) return "public";
  if (words.has("protected") && words.has("internal")) return "protected internal";
  if (words.has("private") && words.has("protected")) return "private protected";
  if (words.has("protected")) return "protected";
  if (words.has("internal")) return "internal";
  if (words.has("private")) return "private";
  return fallback;
}

export type CSharpAttribute = { name: string; expression: string; args: string[]; line: number; column: number; target: string | null };

// Removes whitespace outside string and char literals.
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

// Every attribute of the attribute lists, in order: `[A, B(1, X = 2)]` is two; `[field: A]` has target `field`.
// `args`: positional arguments as written, named ones as `Key=value` (`X = 2` and `X: 2` both).
export function attributesOf(lists: readonly SyntaxNode[]): CSharpAttribute[] {
  const result: CSharpAttribute[] = [];
  for (const list of lists) {
    const target = list.namedChildren.find((child) => child.type === "attribute_target_specifier");
    const targetName = target ? compactNoSpace(target.text).replace(/:$/u, "") : null;
    for (const attribute of list.namedChildren) {
      if (attribute.type !== "attribute") continue;
      const args: string[] = [];
      const argumentList = attribute.namedChildren.find((child) => child.type === "attribute_argument_list");
      for (const argument of argumentList?.namedChildren ?? []) {
        if (argument.type !== "attribute_argument") continue;
        const parts = argument.namedChildren.filter((child) => !isComment(child));
        // `Name = value` and `Name: value` carry the name as a field of the argument.
        const key = argument.childForFieldName("name");
        const value = parts.filter((child) => child.id !== key?.id).at(-1);
        if (!value) continue;
        const written = value.type === "string_literal" || value.type === "verbatim_string_literal" ? value.text : compactOutsideLiterals(value.text);
        args.push(key ? `${key.text}=${written}` : written);
      }
      const nameNode = attribute.childForFieldName("name");
      result.push({
        name: nameNode ? compactNoSpace(nameNode.text) : "",
        expression: compact(attribute.text),
        args,
        line: attribute.startPosition.row + 1,
        column: attribute.startPosition.column,
        target: targetName,
      });
    }
  }
  return result.filter((attribute) => attribute.name !== "");
}

// The type as written, on one line: `Dictionary<string, List<T>>`, `int[]`, `ref int` has no `ref` here.
export function typeText(node: SyntaxNode | null | undefined): string {
  return node ? compact(node.text) : "";
}

// `List<string>` -> `List`, `System.Collections.Generic.List<T>` -> `System.Collections.Generic.List`,
// `Outer<int>.Inner` -> `Outer.Inner`, `Foo?` -> `Foo`, `global::A.B` -> `A.B`, `Foo[,]` -> `Foo[]`.
// Null for `var`, tuples, pointers, function pointers and anything else that is not a name. Predefined types
// are kept as written (`int`, `string`): no declared type has that name.
export function normalizeCSharpType(text: string | null | undefined): string | null {
  if (!text) return null;
  let depth = 0;
  let stripped = "";
  for (const char of text) {
    if (char === "<") depth += 1;
    else if (char === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) stripped += char;
  }
  let type = stripped.replace(/\s+/gu, "").replace(/^global::/u, "").replace(/::/gu, ".");
  type = type.replace(/\[,*\]/gu, "[]").replace(/\?(?=$|\[)/gu, "");
  if (type === "" || type === "var" || type === "dynamic") return null;
  return /^[\p{L}_@][\p{L}\p{N}_@]*(?:\.[\p{L}_@][\p{L}\p{N}_@]*)*(?:\[\])*$/u.test(type) ? type.replace(/@/gu, "") : null;
}

// `List<Foo>` as written without spacing; null when the type has no generic arguments.
export function genericTypeText(text: string | null | undefined): string | null {
  if (!text || !text.includes("<")) return null;
  const type = text.replace(/\s+/gu, " ").replace(/\s*([<>,.])\s*/gu, "$1").trim();
  return type.length <= 160 ? type : null;
}

export function lastSegment(name: string): string {
  return name.split(".").at(-1) ?? name;
}

// Names of the type parameters: `<T, out U>` is ["T", "U"].
export function typeParametersOf(node: SyntaxNode): string[] {
  const list = node.childForFieldName("type_parameters") ?? node.namedChildren.find((child) => child.type === "type_parameter_list") ?? null;
  return list?.namedChildren.filter((child) => child.type === "type_parameter").map((child) => child.childForFieldName("name")?.text ?? compact(child.text)) ?? [];
}

// `where T : class, new()` is { param: "T", constraints: ["class", "new()"] }.
export type CSharpConstraint = { param: string; constraints: string[] };
export function constraintsOf(node: SyntaxNode): CSharpConstraint[] {
  const result: CSharpConstraint[] = [];
  for (const clause of node.namedChildren) {
    if (clause.type !== "type_parameter_constraints_clause") continue;
    const param = clause.namedChildren.find((child) => child.type === "identifier")?.text;
    if (!param) continue;
    const constraints = clause.namedChildren.filter((child) => child.type === "type_parameter_constraint").map((child) => compactNoSpace(child.text));
    result.push({ param, constraints });
  }
  return result;
}

// Parameters of a `parameter_list` or `bracketed_parameter_list`. The grammar leaves `params T[] x` as loose
// children of the list (the `params` keyword, then the type and name fields of the list itself).
export function csharpParameters(list: SyntaxNode | null | undefined): CSharpParameter[] {
  const parameters: CSharpParameter[] = [];
  if (!list) return parameters;
  const children = list.children;
  // Attribute lists written before a `params` parameter are loose children of the list too.
  let loose: SyntaxNode[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!;
    if (child.type === "attribute_list") {
      loose.push(child);
    } else if (child.type === "parameter") {
      loose = [];
      const name = child.childForFieldName("name")?.text;
      if (!name) continue;
      const modifiers = child.namedChildren.filter((candidate) => candidate.type === "modifier").map((candidate) => candidate.text);
      const attributes = attributesOf(child.namedChildren.filter((candidate) => candidate.type === "attribute_list")).map((attribute) => ({ name: attribute.name, args: attribute.args }));
      const defaultNode = child.namedChildren.filter((candidate) => candidate.type !== "modifier" && candidate.type !== "attribute_list" && !isComment(candidate) && candidate.id !== child.childForFieldName("type")?.id && candidate.id !== child.childForFieldName("name")?.id).at(-1);
      const parameter: CSharpParameter = { name, type: typeText(child.childForFieldName("type")) };
      if (modifiers.length > 0) parameter.modifier = modifiers.join(" ");
      if (child.children.some((candidate) => candidate.type === "params")) parameter.params = true;
      if (defaultNode) {
        parameter.optional = true;
        parameter.defaultValue = compact(defaultNode.text).slice(0, 60);
      }
      if (attributes.length > 0) parameter.annotations = attributes;
      parameters.push(parameter);
    } else if (child.type === "params" && !child.isNamed) {
      const name = list.childForFieldName("name")?.text;
      if (!name) continue;
      const annotations = attributesOf(loose).map((attribute) => ({ name: attribute.name, args: attribute.args }));
      loose = [];
      parameters.push({ name, type: typeText(list.childForFieldName("type")), params: true, ...(annotations.length > 0 ? { annotations } : {}) });
    }
  }
  return parameters;
}

// Argument expressions of an `argument_list`, comments left out.
export function argumentNodes(list: SyntaxNode | null | undefined): SyntaxNode[] {
  return list?.namedChildren.filter((argument) => argument.type === "argument") ?? [];
}

// The expression of an `argument` (`ref x`, `name: value` and `out var y` leave the value last).
export function argumentValue(argument: SyntaxNode): SyntaxNode | null {
  return argument.namedChildren.filter((child) => !isComment(child) && child.type !== "name_colon").at(-1) ?? null;
}

// `a.b.C` from an identifier, a generic name (`Gen<int>` is `Gen`), a qualified name or a member-access chain;
// null for anything else (calls, indexers, `this`).
export function dottedName(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  const segments: string[] = [];
  let current: SyntaxNode | null = node;
  // Iterative: walk down the leftmost side, collecting the names from the right.
  while (current) {
    if (current.type === "identifier") {
      segments.push(current.text);
      break;
    }
    if (current.type === "generic_name") {
      const id = current.namedChildren.find((child) => child.type === "identifier");
      if (!id) return null;
      segments.push(id.text);
      break;
    }
    if (current.type === "member_access_expression") {
      const name = current.childForFieldName("name");
      const nameText = name?.type === "generic_name" ? name.namedChildren.find((child) => child.type === "identifier")?.text : name?.type === "identifier" ? name.text : null;
      if (!nameText) return null;
      segments.push(nameText);
      current = current.childForFieldName("expression");
      continue;
    }
    if (current.type === "qualified_name") {
      const name = current.childForFieldName("name");
      const nameText = name?.type === "generic_name" ? name.namedChildren.find((child) => child.type === "identifier")?.text : name?.text;
      if (!nameText) return null;
      segments.push(nameText);
      current = current.childForFieldName("qualifier");
      continue;
    }
    if (current.type === "alias_qualified_name") {
      const name = current.childForFieldName("name");
      if (!name) return null;
      current = name;
      continue;
    }
    return null;
  }
  return segments.length === 0 ? null : segments.reverse().join(".");
}
