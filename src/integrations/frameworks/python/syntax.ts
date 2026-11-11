import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { PythonParsedFunction } from "../../languages/python/parser.js";

// Syntax helpers the Python data, env, HTTP and DI layers share.

export type CallArgs = { positional: SyntaxNode[]; keywords: Map<string, SyntaxNode> };

export function argsOf(call: SyntaxNode): CallArgs {
  const positional: SyntaxNode[] = [];
  const keywords = new Map<string, SyntaxNode>();
  for (const arg of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (arg.type === "comment") continue;
    if (arg.type === "keyword_argument") {
      const name = arg.childForFieldName("name")?.text;
      const value = arg.childForFieldName("value");
      if (name && value) keywords.set(name, value);
    } else if (arg.type !== "list_splat" && arg.type !== "dictionary_splat") {
      positional.push(arg);
    }
  }
  return { positional, keywords };
}

export const compact = (text: string): string => text.replace(/\s+/gu, "");

export const lastSegment = (name: string): string => name.split(".").at(-1) ?? name;

export const unwrap = (node: SyntaxNode | null | undefined): SyntaxNode | null => {
  let current = node ?? null;
  while (current && (current.type === "parenthesized_expression" || current.type === "await")) current = current.namedChildren[0] ?? null;
  return current;
};

// The text of a string node without interpolation, with the placeholder
// `holder(expression)` for each `{…}` of an f-string.
function stringParts(node: SyntaxNode, holder: ((expression: SyntaxNode) => string) | null, constants: ReadonlyMap<string, string>): string | null {
  let text = "";
  const start = node.namedChildren.find((child) => child.type === "string_start")?.text ?? node.text.slice(0, 3);
  const raw = /[rR]/u.test(start.replace(/["']+$/u, ""));
  for (const part of node.namedChildren) {
    if (part.type === "string_content") text += raw ? part.text : unescape(part.text);
    else if (part.type === "interpolation") {
      const expression = part.childForFieldName("expression") ?? part.namedChildren[0];
      if (!expression) return null;
      // A constant fills its hole; anything else is the holder's.
      const known = constants.size > 0 ? stringValue(expression, constants, null, 1) : null;
      if (known !== null) text += known;
      else if (holder) text += holder(expression);
      else return null;
    }
  }
  return text;
}

function unescape(text: string): string {
  return text.replace(/\\\n/gu, "").replace(/\\(["'\\])/gu, "$1").replace(/\\n/gu, "\n").replace(/\\t/gu, "\t");
}

// A string written in source: literals, implicit and `+` concatenation,
// module constants (`constants`), and with `holder` f-strings, `%` and
// `.format(...)` templates (each hole becomes `holder(expression)`).
export function stringValue(
  node: SyntaxNode | null | undefined,
  constants: ReadonlyMap<string, string>,
  holder: ((expression: SyntaxNode) => string) | null = null,
  depth = 0,
): string | null {
  const current = unwrap(node);
  if (!current || depth > 6) return null;
  switch (current.type) {
    case "string":
      return stringParts(current, holder, constants);
    case "concatenated_string": {
      let text = "";
      for (const part of current.namedChildren) {
        const value = part.type === "string" ? stringParts(part, holder, constants) : null;
        if (value === null) return null;
        text += value;
      }
      return text;
    }
    case "identifier":
      return constants.get(current.text) ?? null;
    case "attribute": {
      // `self.TABLE` and `Config.URL` of a constant the file declares.
      const name = current.childForFieldName("attribute")?.text;
      const root = current.childForFieldName("object")?.text;
      return name && root && (root === "self" || root === "cls" || constants.has(`${root}.${name}`)) ? constants.get(`${root}.${name}`) ?? constants.get(name) ?? null : null;
    }
    case "binary_operator": {
      const operator = current.childForFieldName("operator")?.text;
      const left = current.childForFieldName("left");
      const right = current.childForFieldName("right");
      if (operator === "+") {
        const a = stringValue(left, constants, holder, depth + 1);
        const b = stringValue(right, constants, holder, depth + 1);
        if (a !== null && b !== null) return a + b;
        if (holder && a !== null && right) return a + holder(right);
        if (holder && b !== null && left) return holder(left) + b;
        return null;
      }
      if (operator === "%") {
        const template = stringValue(left, constants, holder, depth + 1);
        return template === null ? null : template;
      }
      return null;
    }
    case "call": {
      const callee = current.childForFieldName("function");
      if (callee?.type === "attribute" && callee.childForFieldName("attribute")?.text === "format") {
        const template = stringValue(callee.childForFieldName("object"), constants, holder, depth + 1);
        if (template === null) return null;
        if (!holder) return template;
        const { positional, keywords } = argsOf(current);
        let counter = 0;
        return template.replace(/\{([^{}!:]*)(?:![rsa])?(?::[^{}]*)?\}/gu, (_written, key: string) => {
          const name = key.trim();
          const argument = name === "" ? positional[counter++] : /^\d+$/u.test(name) ? positional[Number(name)] : keywords.get(name);
          return argument ? holder(argument) : holder(current);
        });
      }
      return null;
    }
    default:
      return null;
  }
}

export function stringOnly(node: SyntaxNode | null | undefined, constants: ReadonlyMap<string, string> = new Map()): string | null {
  return stringValue(node, constants, null);
}

// The module-level `NAME = "literal"` assignments of a file, and
// `Class.NAME` ones of class bodies.
export function stringConstants(root: SyntaxNode): Map<string, string> {
  const constants = new Map<string, string>();
  const collect = (statements: SyntaxNode[], prefix: string) => {
    for (const statement of statements) {
      const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
      if (assignment?.type !== "assignment") continue;
      const left = assignment.childForFieldName("left");
      const value = stringValue(assignment.childForFieldName("right"), constants);
      if (left?.type === "identifier" && value !== null) {
        constants.set(left.text, value);
        if (prefix !== "") constants.set(`${prefix}.${left.text}`, value);
      }
    }
  };
  collect(root.namedChildren, "");
  for (const statement of root.namedChildren) {
    const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
    if (definition?.type === "class_definition") collect(definition.childForFieldName("body")?.namedChildren ?? [], definition.childForFieldName("name")?.text ?? "");
  }
  return constants;
}

// The function (or method) a line is written in, the smallest one around it.
export function createOwnerOf(fileNodeId: string, functions: readonly PythonParsedFunction[]): (line: number) => string {
  const owners = functions
    .filter((fn) => typeof fn.node.properties.line === "number" && typeof fn.node.properties.endLine === "number")
    .map((fn) => ({ id: fn.node.id, line: Number(fn.node.properties.line), endLine: Number(fn.node.properties.endLine) }));
  return (line) => owners
    .filter((owner) => owner.line <= line && line <= owner.endLine)
    .sort((left, right) => (left.endLine - left.line) - (right.endLine - right.line))[0]?.id ?? fileNodeId;
}

export function shorten(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

// The names a function's parameters are annotated with, `Optional[X]` unwrapped.
export function parameterTypes(fn: SyntaxNode): Map<string, string> {
  const types = new Map<string, string>();
  for (const parameter of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    const name = parameter.type === "identifier" ? parameter.text
      : parameter.type === "typed_parameter" ? parameter.namedChildren.find((child) => child.type === "identifier")?.text
        : parameter.childForFieldName("name")?.text;
    const type = parameter.childForFieldName("type")?.text;
    if (name && type) types.set(name, type);
  }
  return types;
}
