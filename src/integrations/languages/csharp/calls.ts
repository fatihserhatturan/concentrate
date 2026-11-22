import type { SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import {
  argumentNodes,
  argumentValue,
  compactExpression,
  compactNoSpace,
  dottedName,
  genericTypeText,
  isComment,
  lastSegment,
  normalizeCSharpType,
  typeText,
  type CSharpLocal,
  type CSharpParameter,
} from "./syntax.js";

// Call sites and local variable types of C# code.
//
// `csharpLocals` (a JSON property of every Function node) maps each name declared inside the function, or
// one of its parameters, to what is known of its type: `{"type": "Foo"}` or `null` (a local whose type is
// not known: `var x = F()`, an untyped lambda parameter, a tuple deconstruction, a name declared twice with
// different types). Types are normalized names (generic arguments removed: `List<string>` is `List`; arrays
// keep `[]`). `var x = new T()`, `var x = (T)y` and `var x = y as T` are `{"type": "T"}`.
// Local functions and lambdas are not functions of their own: their calls and names belong to the member
// that holds them.

export type CSharpLocals = Map<string, CSharpLocal | null>;

export type CSharpCallKind = "method" | "constructor" | "explicitConstructor";

function merge(locals: CSharpLocals, name: string, next: CSharpLocal | null): void {
  if (!locals.has(name)) {
    locals.set(name, next);
    return;
  }
  if (JSON.stringify(locals.get(name)) !== JSON.stringify(next)) locals.set(name, null);
}

function declared(typeNode: SyntaxNode | null, value: SyntaxNode | null): CSharpLocal | null {
  const written = typeText(typeNode);
  if (written === "var" || typeNode?.type === "implicit_type") return inferred(value);
  const type = normalizeCSharpType(written);
  if (!type) return null;
  const fullType = genericTypeText(written);
  return fullType && !type.endsWith("[]") ? { type, fullType } : { type };
}

function unwrap(node: SyntaxNode | null): SyntaxNode | null {
  let value = node;
  while (value && (value.type === "parenthesized_expression" || (value.type === "postfix_unary_expression" && value.text.endsWith("!"))) && value.namedChildren[0]) value = value.namedChildren[0]!;
  return value;
}

function inferred(written: SyntaxNode | null): CSharpLocal | null {
  const value = unwrap(written);
  if (!value) return null;
  if (value.type === "object_creation_expression") {
    const text = typeText(value.childForFieldName("type"));
    const type = normalizeCSharpType(text);
    if (!type) return null;
    const fullType = genericTypeText(text);
    return fullType ? { type, fullType } : { type };
  }
  if (value.type === "cast_expression") {
    const type = normalizeCSharpType(typeText(value.childForFieldName("type")));
    return type ? { type } : null;
  }
  if (value.type === "as_expression") {
    const type = normalizeCSharpType(typeText(value.childForFieldName("right")));
    return type ? { type } : null;
  }
  return null;
}

// The value expression of a `variable_declarator`: what follows its name (and a bracketed size).
export function declaratorValue(declarator: SyntaxNode): SyntaxNode | null {
  const name = declarator.childForFieldName("name");
  return declarator.namedChildren.filter((child) => child.id !== name?.id && child.type !== "bracketed_argument_list" && !isComment(child)).at(-1) ?? null;
}

// Names bound by a deconstruction `var (a, b)` or `(int a, var b)`: their types are not read.
function designationNames(root: SyntaxNode): string[] {
  const names: string[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "identifier") names.push(node.text);
    else for (const child of node.namedChildren) stack.push(child);
  }
  return names;
}

// The parameters and the declarations of a body: `T x`, `var x = new T()`, for-each variables, using
// declarations, catch parameters, `is T x` patterns, `out T x`, lambda and local function parameters.
export function readLocals(roots: readonly SyntaxNode[], parameters: readonly CSharpParameter[]): CSharpLocals {
  const locals: CSharpLocals = new Map();
  for (const parameter of parameters) {
    const type = normalizeCSharpType(parameter.type);
    const fullType = genericTypeText(parameter.type);
    merge(locals, parameter.name, type ? (fullType && !type.endsWith("[]") ? { type, fullType } : { type }) : null);
  }
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "variable_declaration": {
        const typeNode = node.childForFieldName("type");
        for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
          const name = declarator.childForFieldName("name")?.text;
          if (name) merge(locals, name, declared(typeNode, declaratorValue(declarator)));
          else for (const bound of designationNames(declarator.namedChildren.find((child) => child.type !== "identifier") ?? declarator)) merge(locals, bound, null);
        }
        break;
      }
      case "foreach_statement": {
        const left = node.childForFieldName("left");
        if (left?.type === "identifier") merge(locals, left.text, declared(node.childForFieldName("type"), null));
        else if (left) for (const bound of designationNames(left)) merge(locals, bound, null);
        break;
      }
      case "catch_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) merge(locals, name, declared(node.childForFieldName("type"), null));
        break;
      }
      case "declaration_pattern":
      case "declaration_expression": {
        const name = node.childForFieldName("name")?.text;
        if (name) merge(locals, name, declared(node.childForFieldName("type"), null));
        break;
      }
      case "single_variable_designation":
        merge(locals, node.text, null);
        break;
      case "parameter": {
        // A lambda or local function parameter (the member's own parameters are not in its body).
        const name = node.childForFieldName("name")?.text;
        const typeNode = node.childForFieldName("type");
        if (name) merge(locals, name, typeNode ? declared(typeNode, null) : null);
        break;
      }
      case "lambda_expression": {
        const list = node.childForFieldName("parameters");
        if (list?.type === "identifier") merge(locals, list.text, null);
        break;
      }
      default:
        break;
    }
  };
  // Iterative pre-order walk: expression chains can be thousands of levels deep.
  const stack: SyntaxNode[] = [];
  for (let r = roots.length - 1; r >= 0; r--) stack.push(roots[r]!);
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return locals;
}

export const callLikeTypes: ReadonlySet<string> = new Set([
  "invocation_expression",
  "object_creation_expression",
  "implicit_object_creation_expression",
  "constructor_initializer",
]);

// True when the code holds a call site.
export function hasCallSite(root: SyntaxNode): boolean {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (callLikeTypes.has(node.type)) return true;
    for (const child of node.namedChildren) stack.push(child);
  }
  return false;
}

const literalTypes: Readonly<Record<string, string>> = {
  string_literal: "string",
  verbatim_string_literal: "string",
  raw_string_literal: "string",
  interpolated_string_expression: "string",
  boolean_literal: "bool",
  character_literal: "char",
  null_literal: "null",
  typeof_expression: "Type",
};

// The type of one argument when it is certain from the call site alone, as a short token the resolver reads back:
// a type name (`string`, `int`, a class from `new T()`, the declared type of a typed local), `this`, `null`, or
// `@name` for a field or property (the resolver finds its type). Null for anything else.
function argumentType(argument: SyntaxNode, locals: CSharpLocals): string | null {
  const value = unwrap(argumentValue(argument));
  if (!value) return null;
  const literal = literalTypes[value.type];
  if (literal) return literal;
  switch (value.type) {
    case "integer_literal": {
      const suffix = /[lLuU]+$/u.exec(value.text)?.[0]?.toLowerCase() ?? "";
      return suffix.includes("u") && suffix.includes("l") ? "ulong" : suffix.includes("l") ? "long" : suffix.includes("u") ? "uint" : "int";
    }
    case "real_literal": {
      const suffix = /[fFmMdD]$/u.exec(value.text)?.[0]?.toLowerCase();
      return suffix === "f" ? "float" : suffix === "m" ? "decimal" : "double";
    }
    case "this":
      return "this";
    case "identifier":
      return locals.has(value.text) ? locals.get(value.text)?.type ?? null : `@${value.text}`;
    case "member_access_expression": {
      const name = value.childForFieldName("name");
      return value.childForFieldName("expression")?.type === "this" && name?.type === "identifier" && !locals.has(name.text) ? `@${name.text}` : null;
    }
    case "object_creation_expression":
      return normalizeCSharpType(typeText(value.childForFieldName("type")));
    case "cast_expression":
      return normalizeCSharpType(typeText(value.childForFieldName("type")));
    case "as_expression":
      return normalizeCSharpType(typeText(value.childForFieldName("right")));
    default:
      return null;
  }
}

// The certain argument types of a call, as a JSON array with null for the uncertain ones; null when none is certain.
function argumentTypes(list: SyntaxNode | null | undefined, locals: CSharpLocals): string | null {
  const types = argumentNodes(list).map((argument) => argumentType(argument, locals));
  return types.some((type) => type !== null) ? JSON.stringify(types) : null;
}

// `Type.M()` and `a.b.C.M()` have a receiver that is a dotted name whose first segment is not a local: it is a
// type, a namespace-qualified type, or a field or property (or a chain of them).
function qualifierOf(receiver: SyntaxNode | null, locals: CSharpLocals): string | null {
  if (!receiver) return null;
  if (receiver.type === "predefined_type") return receiver.text;
  const name = dottedName(receiver);
  if (!name) return null;
  return locals.has(name.split(".")[0]!) ? null : name;
}

// How the receiver is written: `this`, `base`, `identifier` (a name), `member` (a dotted chain), `this-member` /
// `base-member` (`this.f.Go()`: a chain of members of `this`/`base`), `type` (a keyword type:
// `string.Join`), `new`, `invocation` (the result of a call), `element`, `cast` (`((T)x).M()`, `(x as T).M()`), `other`.
export function receiverKindOf(receiver: SyntaxNode | null): string | null {
  const node = unwrap(receiver);
  if (!node) return null;
  switch (node.type) {
    case "this":
      return "this";
    case "base":
      return "base";
    case "identifier":
    case "generic_name":
      return "identifier";
    case "predefined_type":
      return "type";
    case "member_access_expression":
    case "qualified_name":
    case "alias_qualified_name": {
      if (dottedName(node)) return "member";
      // `this.f.Go()`: a chain of members of `this` (or `base`).
      let root: SyntaxNode | null = node;
      while (root?.type === "member_access_expression") root = root.childForFieldName("expression");
      return root?.type === "this" ? "this-member" : root?.type === "base" ? "base-member" : "other";
    }
    case "object_creation_expression":
    case "implicit_object_creation_expression":
      return "new";
    case "invocation_expression":
      return "invocation";
    case "element_access_expression":
      return "element";
    case "cast_expression":
    case "as_expression":
      return "cast";
    default:
      return "other";
  }
}

function receiverProperties(receiver: SyntaxNode | null, locals: CSharpLocals): Record<string, string | boolean> {
  const node = unwrap(receiver);
  if (!node) return {};
  if (node.type === "object_creation_expression") {
    const type = normalizeCSharpType(typeText(node.childForFieldName("type")));
    return type ? { receiverConstructor: type } : {};
  }
  if (node.type === "cast_expression" || node.type === "as_expression") {
    const type = normalizeCSharpType(typeText(node.childForFieldName(node.type === "cast_expression" ? "type" : "right")));
    return type ? { receiverType: type } : {};
  }
  if (node.type !== "identifier" || !locals.has(node.text)) return {};
  const local = locals.get(node.text);
  return local?.type ? { receiverIsLocal: true, receiverType: local.type } : { receiverIsLocal: true };
}

function build(
  functionId: string,
  node: SyntaxNode,
  expression: string,
  callee: string,
  receiver: SyntaxNode | null,
  receiverText: string | null,
  kind: CSharpCallKind,
  extra: Record<string, string | number | boolean | null>,
  locals: CSharpLocals,
): GraphNode {
  const line = node.startPosition.row + 1;
  const qualifier = qualifierOf(unwrap(receiver), locals);
  const receiverKind = receiverKindOf(receiver);
  return {
    id: `${functionId}:call:${line}:${node.startPosition.column}:${expression}`,
    label: "Call",
    properties: {
      name: expression,
      expression,
      callee,
      receiver: receiverText,
      line,
      columnNumber: node.startPosition.column,
      callKind: kind,
      ...(receiverKind === null ? {} : { receiverKind }),
      ...(qualifier === null ? {} : { qualifier }),
      ...receiverProperties(receiver, locals),
      ...extra,
    },
  };
}

function withArguments(node: SyntaxNode, locals: CSharpLocals): Record<string, string | number> {
  const list = node.childForFieldName("arguments") ?? node.namedChildren.find((child) => child.type === "argument_list") ?? null;
  const types = argumentTypes(list, locals);
  return { argumentCount: argumentNodes(list).length, ...(types === null ? {} : { argumentTypes: types }) };
}

// The simple name and generic arguments of a method name (`Gen<int>` is `Gen`, `int`).
function nameAndTypeArguments(node: SyntaxNode | null): { name: string; typeArguments: string | null } | null {
  if (!node) return null;
  if (node.type === "identifier") return { name: node.text, typeArguments: null };
  if (node.type === "generic_name") {
    const id = node.namedChildren.find((child) => child.type === "identifier");
    const list = node.namedChildren.find((child) => child.type === "type_argument_list");
    return id ? { name: id.text, typeArguments: list ? compactNoSpace(list.text).slice(1, -1) : null } : null;
  }
  return null;
}

// What `new()` constructs when the declaration around it says so: `Foo x = new();`, a field or property `Foo X = new();`,
// `x = new();` for a local `x` of known type. Null when the type is not written anywhere near.
function implicitTargetType(node: SyntaxNode, locals: CSharpLocals): string | null {
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === "variable_declarator" && parent.parent?.type === "variable_declaration") return normalizeCSharpType(typeText(parent.parent.childForFieldName("type")));
  if (parent.type === "property_declaration") return normalizeCSharpType(typeText(parent.childForFieldName("type")));
  if (parent.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "identifier") return locals.get(left.text)?.type ?? null;
  }
  return null;
}

// The Call node of an invocation, `new T(...)`, target-typed `new(...)` or `this(...)` / `base(...)`; null when `node`
// is none of them or its callee is not a name (a call of a call result, of a parenthesized expression).
export function createCallNode(functionId: string, node: SyntaxNode, locals: CSharpLocals): GraphNode | null {
  switch (node.type) {
    case "invocation_expression": {
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      const args = withArguments(node, locals);
      if (fn.type === "identifier" || fn.type === "generic_name") {
        const parts = nameAndTypeArguments(fn);
        if (!parts) return null;
        return build(functionId, node, parts.name, parts.name, null, null, "method", { ...args, ...(parts.typeArguments ? { typeArguments: parts.typeArguments } : {}) }, locals);
      }
      if (fn.type === "member_access_expression") {
        const parts = nameAndTypeArguments(fn.childForFieldName("name"));
        const object = fn.childForFieldName("expression");
        if (!parts || !object) return null;
        return build(functionId, node, `${compactExpression(object.text)}.${parts.name}`, parts.name, object, compactExpression(object.text), "method", { ...args, ...(parts.typeArguments ? { typeArguments: parts.typeArguments } : {}) }, locals);
      }
      if (fn.type === "conditional_access_expression") {
        const condition = fn.childForFieldName("condition");
        const tail = fn.namedChildren.filter((child) => child.id !== condition?.id && !isComment(child)).at(-1);
        if (!condition || !tail) return null;
        let nameNode: SyntaxNode | null = null;
        let receiver: SyntaxNode | null = condition;
        let receiverText = compactExpression(condition.text);
        if (tail.type === "member_binding_expression") {
          nameNode = tail.childForFieldName("name");
        } else if (tail.type === "member_access_expression") {
          nameNode = tail.childForFieldName("name");
          // `a?.B.C()`: the receiver is everything before `.C`.
          receiver = null;
          receiverText = compactExpression(fn.text.slice(0, (nameNode?.startIndex ?? fn.endIndex) - fn.startIndex)).replace(/\.$/u, "");
        } else return null;
        const parts = nameAndTypeArguments(nameNode);
        if (!parts) return null;
        return build(functionId, node, `${receiverText}?.${parts.name}`, parts.name, receiver, receiverText, "method", { ...args, isConditional: true, ...(parts.typeArguments ? { typeArguments: parts.typeArguments } : {}) }, locals);
      }
      return null;
    }
    case "object_creation_expression": {
      const typeNode = node.childForFieldName("type");
      const type = normalizeCSharpType(typeText(typeNode));
      if (!type) return null;
      const call = build(functionId, node, `new ${type}`, lastSegment(type), null, null, "constructor", withArguments(node, locals), locals);
      if (type.includes(".")) call.properties.qualifier = type.slice(0, type.lastIndexOf("."));
      return call;
    }
    case "implicit_object_creation_expression": {
      const type = implicitTargetType(node, locals);
      if (!type) return build(functionId, node, "new()", "new", null, null, "constructor", { ...withArguments(node, locals), receiverKind: "implicit-new" }, locals);
      const call = build(functionId, node, `new ${type}`, lastSegment(type), null, null, "constructor", { ...withArguments(node, locals), receiverKind: "implicit-new" }, locals);
      if (type.includes(".")) call.properties.qualifier = type.slice(0, type.lastIndexOf("."));
      return call;
    }
    case "constructor_initializer": {
      const target = node.children.find((child) => child.type === "this" || child.type === "base");
      if (!target) return null;
      return build(functionId, node, target.type, target.type, null, null, "explicitConstructor", withArguments(node, locals), locals);
    }
    default:
      return null;
  }
}
