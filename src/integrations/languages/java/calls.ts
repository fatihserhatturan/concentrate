import type { SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import {
  argumentCount,
  compactExpression,
  compactNoSpace,
  dottedName,
  lastSegment,
  normalizeJavaType,
  typeDeclarationTypes,
  typeText,
  type JavaLocal,
  type JavaParameter,
} from "./syntax.js";

// Call sites and local variable types of Java code.
//
// `javaLocals` (a JSON property of every Function node) maps each name that is
// declared inside the function, or is one of its parameters, to what is known
// of its type: `{"type": "Foo"}` or `null` (a local whose type is not known:
// `var x = f()`, a lambda parameter without a type, a name declared twice with
// different types). Types are normalized names (generic arguments removed:
// `List<String>` is `List`; arrays keep `[]`). `var x = new T()` and
// `var x = (T) y` are `{"type": "T"}`.

export type JavaLocals = Map<string, JavaLocal | null>;

export type JavaCallKind = "method" | "constructor" | "explicitConstructor" | "methodReference" | "constructorReference";

const isComment = (node: SyntaxNode) => node.type === "line_comment" || node.type === "block_comment";

// A node whose subtree is another declaration: its names and calls belong to it.
function isNestedScope(node: SyntaxNode): boolean {
  return typeDeclarationTypes.has(node.type)
    || (node.type === "class_body" && (node.parent?.type === "object_creation_expression" || node.parent?.type === "enum_constant"));
}

function merge(locals: JavaLocals, name: string, next: JavaLocal | null): void {
  if (!locals.has(name)) {
    locals.set(name, next);
    return;
  }
  if (JSON.stringify(locals.get(name)) !== JSON.stringify(next)) locals.set(name, null);
}

function declared(typeNode: SyntaxNode | null, dimensions: SyntaxNode | null, value: SyntaxNode | null): JavaLocal | null {
  const written = typeText(typeNode);
  if (written === "var") return inferred(value);
  const type = normalizeJavaType(`${written}${dimensions ? compactNoSpace(dimensions.text) : ""}`);
  return type ? { type } : null;
}

function inferred(written: SyntaxNode | null): JavaLocal | null {
  let value = written;
  while (value?.type === "parenthesized_expression" && value.namedChildren[0]) value = value.namedChildren[0];
  if (!value) return null;
  if (value.type === "object_creation_expression") {
    const type = normalizeJavaType(typeText(value.childForFieldName("type")));
    return type ? { type } : null;
  }
  if (value.type === "cast_expression") {
    const type = normalizeJavaType(typeText(value.childForFieldName("type")));
    return type ? { type } : null;
  }
  return null;
}

// The parameters and the declarations of a body: `T x`, `var x = new T()`, for-each variables,
// try-with-resources, catch parameters, `instanceof T x` patterns and lambda parameters.
export function readLocals(roots: readonly SyntaxNode[], parameters: readonly JavaParameter[]): JavaLocals {
  const locals: JavaLocals = new Map();
  for (const parameter of parameters) {
    const type = normalizeJavaType(parameter.type);
    merge(locals, parameter.name, type ? { type } : null);
  }
  const visit = (node: SyntaxNode): void => {
    if (isNestedScope(node)) return;
    switch (node.type) {
      case "local_variable_declaration": {
        const typeNode = node.childForFieldName("type");
        for (const declarator of node.childrenForFieldName("declarator")) {
          const name = declarator.childForFieldName("name")?.text;
          if (name) merge(locals, name, declared(typeNode, declarator.childForFieldName("dimensions"), declarator.childForFieldName("value")));
        }
        break;
      }
      case "enhanced_for_statement": {
        const name = node.childForFieldName("name")?.text;
        if (name) merge(locals, name, declared(node.childForFieldName("type"), node.childForFieldName("dimensions"), null));
        break;
      }
      case "resource": {
        const name = node.childForFieldName("name")?.text;
        if (name) merge(locals, name, declared(node.childForFieldName("type"), node.childForFieldName("dimensions"), node.childForFieldName("value")));
        break;
      }
      case "catch_formal_parameter": {
        const name = node.childForFieldName("name")?.text;
        const types = node.namedChildren.find((child) => child.type === "catch_type")?.namedChildren.filter((child) => !isComment(child)) ?? [];
        if (name) merge(locals, name, types.length === 1 ? declared(types[0]!, null, null) : null);
        break;
      }
      case "instanceof_expression": {
        const name = node.childForFieldName("name")?.text;
        if (name) merge(locals, name, declared(node.childForFieldName("right"), null, null));
        break;
      }
      case "lambda_expression": {
        const list = node.childForFieldName("parameters");
        if (list?.type === "identifier") {
          merge(locals, list.text, null);
        } else if (list?.type === "inferred_parameters") {
          for (const child of list.namedChildren) if (child.type === "identifier") merge(locals, child.text, null);
        } else if (list) {
          for (const parameter of list.namedChildren) {
            if (parameter.type === "identifier") merge(locals, parameter.text, null);
            else if (parameter.type === "formal_parameter") {
              const name = parameter.childForFieldName("name")?.text;
              if (name) merge(locals, name, declared(parameter.childForFieldName("type"), null, null));
            }
          }
        }
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
    if (isNestedScope(node)) continue;
    visit(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return locals;
}

export const callLikeTypes: ReadonlySet<string> = new Set([
  "method_invocation",
  "object_creation_expression",
  "explicit_constructor_invocation",
  "method_reference",
  "enum_constant",
]);

// True when the code holds a call site (not counting nested declarations).
export function hasCallSite(root: SyntaxNode): boolean {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isNestedScope(node)) continue;
    if (callLikeTypes.has(node.type)) return true;
    for (const child of node.namedChildren) stack.push(child);
  }
  return false;
}

// `Type.m()` and `a.b.C.m()` have a receiver that is a dotted name and not a local variable:
// it is a type, a package-qualified type or a field (or a chain of fields).
function qualifierOf(receiver: SyntaxNode | null, locals: JavaLocals): string | null {
  const name = dottedName(receiver);
  if (!name || name === "this" || name === "super") return null;
  return locals.has(name.split(".")[0]!) ? null : name;
}

function receiverProperties(receiver: SyntaxNode | null, locals: JavaLocals): Record<string, string | boolean> {
  if (!receiver) return {};
  if (receiver.type === "object_creation_expression" && !receiver.namedChildren.some((child) => child.type === "class_body")) {
    const type = normalizeJavaType(typeText(receiver.childForFieldName("type")));
    return type ? { receiverConstructor: type } : {};
  }
  if (receiver.type !== "identifier" || !locals.has(receiver.text)) return {};
  const local = locals.get(receiver.text);
  return local ? { receiverIsLocal: true, receiverType: local.type } : { receiverIsLocal: true };
}

function build(
  functionId: string,
  node: SyntaxNode,
  expression: string,
  callee: string,
  receiver: SyntaxNode | null,
  kind: JavaCallKind,
  extra: Record<string, string | number | boolean | null>,
  locals: JavaLocals,
): GraphNode {
  const line = node.startPosition.row + 1;
  const receiverText = receiver ? compactExpression(receiver.text) : null;
  const qualifier = qualifierOf(receiver, locals);
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
      ...(qualifier === null ? {} : { qualifier }),
      ...receiverProperties(receiver, locals),
      ...extra,
    },
  };
}

// The Call node of a method invocation, `new T(...)`, `this(...)` / `super(...)`
// or method reference; null when `node` is none of them.
export function createCallNode(functionId: string, node: SyntaxNode, locals: JavaLocals): GraphNode | null {
  switch (node.type) {
    case "method_invocation": {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const object = node.childForFieldName("object");
      const expression = object ? `${compactExpression(object.text)}.${name}` : name;
      return build(functionId, node, expression, name, object, "method", { argumentCount: argumentCount(node.childForFieldName("arguments")) }, locals);
    }
    case "object_creation_expression": {
      const type = normalizeJavaType(typeText(node.childForFieldName("type")));
      if (!type) return null;
      const object = node.childForFieldName("object") ?? node.namedChildren.find((child) => child.id !== node.childForFieldName("type")?.id && child.type !== "argument_list" && child.type !== "class_body" && child.type !== "type_arguments" && child.type !== "modifiers" && !isComment(child)) ?? null;
      const call = build(functionId, node, `new ${type}`, lastSegment(type), null, "constructor", { argumentCount: argumentCount(node.childForFieldName("arguments")) }, locals);
      const prefix = type.includes(".") ? type.slice(0, type.lastIndexOf(".")) : null;
      if (prefix) call.properties.qualifier = prefix;
      if (object && object.id !== node.childForFieldName("type")?.id) call.properties.receiver = compactExpression(object.text);
      return call;
    }
    case "explicit_constructor_invocation": {
      const constructor = node.childForFieldName("constructor")?.text;
      if (constructor !== "this" && constructor !== "super") return null;
      const object = node.childForFieldName("object");
      return build(functionId, node, constructor, constructor, object, "explicitConstructor", { argumentCount: argumentCount(node.childForFieldName("arguments")) }, locals);
    }
    case "method_reference": {
      const children = node.children;
      const last = children.at(-1);
      const target = node.namedChildren.find((child) => !isComment(child) && child.type !== "type_arguments") ?? null;
      if (!last || !target) return null;
      const isConstructor = last.text === "new";
      const name = last.text;
      const receiver = compactExpression(target.text);
      return build(functionId, node, `${receiver}::${name}`, name, target, isConstructor ? "constructorReference" : "methodReference", {}, locals);
    }
    default:
      return null;
  }
}

// `A(1)` among the constants of an enum is a call of one of its constructors.
export function createEnumConstantCall(functionId: string, node: SyntaxNode, enumQualifiedName: string, locals: JavaLocals): GraphNode {
  return build(functionId, node, `new ${lastSegment(enumQualifiedName)}`, lastSegment(enumQualifiedName), null, "constructor", { argumentCount: argumentCount(node.childForFieldName("arguments")), receiverType: enumQualifiedName }, locals);
}
