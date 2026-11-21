import type { SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import {
  argumentCount,
  compactExpression,
  compactNoSpace,
  dottedName,
  genericTypeText,
  lastSegment,
  normalizeJavaType,
  typeDeclarationTypes,
  typeText,
  type JavaLambdaContext,
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
  if (!type) return null;
  const fullType = dimensions ? null : genericTypeText(written);
  return fullType ? { type, fullType } : { type };
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
    const fullType = genericTypeText(parameter.type);
    merge(locals, parameter.name, type ? (fullType ? { type, fullType } : { type }) : null);
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
        const lambdaParameters = list?.type === "identifier" ? [list] : (list?.namedChildren ?? []).filter((child) => !isComment(child));
        const untyped = (child: SyntaxNode): JavaLocal | null => {
          const lambda = lambdaContext(node, lambdaParameters.findIndex((candidate) => candidate.id === child.id));
          return lambda ? { lambda } : null;
        };
        if (list?.type === "identifier") {
          merge(locals, list.text, untyped(list));
        } else if (list?.type === "inferred_parameters") {
          for (const child of list.namedChildren) if (child.type === "identifier") merge(locals, child.text, untyped(child));
        } else if (list) {
          for (const parameter of list.namedChildren) {
            if (parameter.type === "identifier") merge(locals, parameter.text, untyped(parameter));
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

// An expression's text with the bodies of anonymous classes cut out (`new Foo(){...}` is `new Foo(){}`).
function expressionText(node: SyntaxNode): string {
  const cuts: Array<{ start: number; end: number }> = [];
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "class_body" && current.parent?.type === "object_creation_expression") {
      cuts.push({ start: current.startIndex - node.startIndex, end: current.endIndex - node.startIndex });
      continue;
    }
    for (const child of current.namedChildren) stack.push(child);
  }
  let text = node.text;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) text = `${text.slice(0, cut.start)}{}${text.slice(cut.end)}`;
  return compactExpression(text);
}

// The method call a lambda is a direct argument of, with the lambda parameter's position.
function lambdaContext(lambda: SyntaxNode, param: number): JavaLambdaContext | null {
  const list = lambda.parent;
  const call = list?.parent;
  if (param < 0 || list?.type !== "argument_list" || call?.type !== "method_invocation") return null;
  const callee = call.childForFieldName("name")?.text;
  const args = list.namedChildren.filter((child) => !isComment(child));
  const arg = args.findIndex((child) => child.id === lambda.id);
  if (!callee || arg < 0) return null;
  const object = call.childForFieldName("object");
  return { callee, receiver: object ? expressionText(object) : null, arity: args.length, arg, param };
}

const simpleArgumentTypes: ReadonlySet<string> = new Set([
  "identifier", "this", "string_literal", "decimal_integer_literal", "hex_integer_literal", "decimal_floating_point_literal",
  "true", "false", "character_literal", "field_access", "object_creation_expression", "method_invocation",
]);

// The arguments of a call as short expressions (null for the ones too complex to type): overloads are told apart by them.
function argumentTexts(list: SyntaxNode | null | undefined): string | null {
  const args = list?.namedChildren.filter((argument) => !isComment(argument)) ?? [];
  const texts = args.map((argument) => {
    if (!simpleArgumentTypes.has(argument.type)) return null;
    if (argument.type === "object_creation_expression" && argument.namedChildren.some((child) => child.type === "class_body")) return null;
    const text = compactExpression(argument.text);
    return text.length <= 120 ? text : null;
  });
  return texts.some((text) => text !== null) ? JSON.stringify(texts) : null;
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
  return local?.type ? { receiverIsLocal: true, receiverType: local.type } : { receiverIsLocal: true };
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
  takeArguments(extra, locals, line, node.startPosition.column);
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

function withArguments(node: SyntaxNode): Record<string, string | number> {
  const list = node.childForFieldName("arguments");
  const texts = argumentTexts(list);
  return { argumentCount: argumentCount(list), ...(texts === null ? {} : { argumentTexts: texts }) };
}

// The argument expressions travel in the function's `javaLocals`, under `#line:column`, not as a Call property.
function takeArguments(extra: Record<string, string | number | boolean | null>, locals: JavaLocals, line: number, column: number): void {
  const texts = extra.argumentTexts;
  delete extra.argumentTexts;
  if (typeof texts === "string") locals.set(`#${line}:${column}`, { args: JSON.parse(texts) as Array<string | null> });
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
      return build(functionId, node, expression, name, object, "method", withArguments(node), locals);
    }
    case "object_creation_expression": {
      const type = normalizeJavaType(typeText(node.childForFieldName("type")));
      if (!type) return null;
      const object = node.childForFieldName("object") ?? node.namedChildren.find((child) => child.id !== node.childForFieldName("type")?.id && child.type !== "argument_list" && child.type !== "class_body" && child.type !== "type_arguments" && child.type !== "modifiers" && !isComment(child)) ?? null;
      const call = build(functionId, node, `new ${type}`, lastSegment(type), null, "constructor", withArguments(node), locals);
      const prefix = type.includes(".") ? type.slice(0, type.lastIndexOf(".")) : null;
      if (prefix) call.properties.qualifier = prefix;
      if (object && object.id !== node.childForFieldName("type")?.id) call.properties.receiver = compactExpression(object.text);
      return call;
    }
    case "explicit_constructor_invocation": {
      const constructor = node.childForFieldName("constructor")?.text;
      if (constructor !== "this" && constructor !== "super") return null;
      const object = node.childForFieldName("object");
      return build(functionId, node, constructor, constructor, object, "explicitConstructor", withArguments(node), locals);
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
