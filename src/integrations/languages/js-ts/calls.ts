import { indexOfNode, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import {
  analyzeMemberCallExpression,
  walkScoped,
  type CallExpressionParts,
} from "../tree-sitter-utils.js";
import {
  extractName,
  isClassNode,
  isFunctionNode,
  isModuleLevelDeclarator,
  isVariableClassValue,
  isVariableFunctionValue,
  moduleObjectPropertyFunctionName,
} from "./common.js";
import {
  extractFunctionParameters,
  extractReturnType,
} from "./function-signature.js";

type CallParts = Omit<CallExpressionParts, "callee"> & { callee: string | null; requireSource?: string };

// `require("./x")(...)` calls whatever the required module exports: record
// the module instead of splitting the string on its dots.
function analyzeCallFunction(functionNode: SyntaxNode | null): CallParts | null {
  const source = functionNode ? requiredModuleSource(functionNode) : null;
  if (functionNode && source !== null) {
    return { expression: functionNode.text, callee: null, receiver: null, requireSource: source };
  }
  return analyzeMemberCallExpression(functionNode?.text);
}

function requiredModuleSource(node: SyntaxNode): string | null {
  if (node.type !== "call_expression" || node.childForFieldName("function")?.text !== "require") return null;
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.length !== 1 || args[0]!.type !== "string") return null;
  return args[0]!.text.slice(1, -1);
}

export function isInlineHandlerArgument(node: SyntaxNode): boolean {
  if (node.type !== "arrow_function" && node.type !== "function_expression") return false;
  if (node.parent?.type !== "arguments") return false;
  const callExpr = node.parent.parent;
  if (!callExpr || callExpr.type !== "call_expression") return false;
  return isModuleLevelCallExpression(callExpr);
}

const scopedRouteMethods = new Set(["all", "del", "delete", "get", "head", "options", "patch", "post", "put", "use"]);

// An inline function passed after a path to a route-shaped statement call in
// a function body (`instance.get('/users', async (req) => …)` in a plugin
// or an app factory), and the function that call belongs to. The gate
// is the call's shape only, so `.then(() => …)` and `.map((x) => …)` stay part
// of their function. The owner must have a Function node, or be the unnamed
// module export, whose calls belong to the file.
export function scopedRouteHandlerOwner(node: SyntaxNode, callbackKeys: ReadonlySet<string>): SyntaxNode | null {
  if (node.type !== "arrow_function" && node.type !== "function_expression") return null;
  if (node.parent?.type !== "arguments") return null;
  const callExpr = node.parent.parent;
  if (callExpr?.type !== "call_expression" || isModuleLevelCallExpression(callExpr)) return null;

  const statement = callExpr.parent?.type === "await_expression" ? callExpr.parent.parent : callExpr.parent;
  if (statement?.type !== "expression_statement") return null;

  const callee = callExpr.childForFieldName("function");
  const method = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
  if (!method || !scopedRouteMethods.has(method)) return null;

  const args = node.parent.namedChildren;
  if (args[0]?.type !== "string" && args[0]?.type !== "template_string") return null;
  if (args[0].id === node.id) return null;

  let owner = statement.parent;
  while (owner && !isFunctionNode(owner) && !isClassNode(owner)) owner = owner.parent;
  if (!owner || !isFunctionNode(owner) || owner.type === "method_definition") return null;
  return ownsCalls(owner, callbackKeys) || isAnonymousModuleExport(owner) ? owner : null;
}

function isAnonymousModuleExport(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type === "assignment_expression") {
    return parent.childForFieldName("right")?.id === node.id
      && /^(module\.)?exports$/u.test(parent.childForFieldName("left")?.text ?? "")
      && parent.parent?.parent?.type === "program";
  }
  return parent?.type === "export_statement" && parent.children.some((child) => child.type === "default");
}

// A callback passed to the call that initializes a module-level variable:
// `export const User = createParamDecorator((data, ctx) => { … })`, or the
// default export: `export default defineNuxtPlugin((nuxtApp) => { … })`.
export function isInitializerHandlerArgument(node: SyntaxNode): boolean {
  if (node.type !== "arrow_function" && node.type !== "function_expression") return false;
  if (node.parent?.type !== "arguments") return false;
  const callExpr = node.parent.parent;
  if (!callExpr || callExpr.type !== "call_expression") return false;
  const declarator = callExpr.parent;
  if (declarator?.type === "export_statement") {
    return declarator.namedChildren[0]?.id === callExpr.id && declarator.children.some((child) => child.type === "default");
  }
  return declarator?.type === "variable_declarator"
    && declarator.childForFieldName("value")?.id === callExpr.id
    && isModuleLevelDeclarator(declarator);
}

// A function stored under one of `callbackKeys` in an object literal passed to
// a module-level call: `register({ url: "/x", handler: () => { … } })`.
// Frameworks declare the keys (JsTsFrameworkPlugin.callbackPropertyNames).
export function isObjectLiteralHandlerFunction(node: SyntaxNode, callbackKeys: ReadonlySet<string>): boolean {
  if (node.type !== "arrow_function" && node.type !== "function_expression") return false;
  if (node.parent?.type !== "pair") return false;

  const key = node.parent.childForFieldName("key");
  if (!key || !callbackKeys.has(normalizePropertyName(key))) return false;

  const objectNode = node.parent.parent;
  const argsNode = objectNode?.parent;
  const callExpr = argsNode?.parent;
  if (objectNode?.type !== "object" || argsNode?.type !== "arguments" || callExpr?.type !== "call_expression") {
    return false;
  }

  return isModuleLevelCallExpression(callExpr);
}

export function createInlineHandlerNode(
  fileNodeId: string,
  handlerNode: SyntaxNode,
  callKind: "modulecall" | "initializercall" | "call" = "modulecall",
  callOwnerId: string = fileNodeId,
): { functionNode: GraphNode; callNodeId: string } | null {
  const argsNode = handlerNode.parent;
  const callExprNode = argsNode?.parent;
  if (!argsNode || !callExprNode) return null;

  const calleeText = callExprNode.childForFieldName("function")?.text ?? "unknown";
  const callParts = analyzeMemberCallExpression(calleeText);
  const expression = callParts?.expression ?? calleeText;

  const firstString = argsNode.namedChildren
    .find((c) => c.type === "string")
    ?.text.replace(/^["']|["']$/g, "");

  const argIndex = indexOfNode(argsNode.namedChildren, handlerNode);
  const syntheticName = firstString
    ? `<${expression}:${firstString}:arg${argIndex}>`
    : `<${expression}:arg${argIndex}>`;

  const row = callExprNode.startPosition.row + 1;
  const col = callExprNode.startPosition.column;
  // A call inside a function has its owner's id as prefix (createCallNodes).
  const callNodeId = `${callOwnerId}:${callKind}:${row}:${col}:${expression}`;

  return {
    functionNode: {
      id: `${fileNodeId}:function:${handlerNode.startPosition.row + 1}:${syntheticName}`,
      label: "Function",
      properties: {
        name: syntheticName,
        kind: handlerNode.type,
        methodKind: null,
        line: handlerNode.startPosition.row + 1,
        endLine: handlerNode.endPosition.row + 1,
        className: null,
        isExported: false,
        isAsync: handlerNode.children.some((c) => c.type === "async"),
        isAbstract: false,
        visibility: "public",
        parameters: extractFunctionParameters(handlerNode),
        returnType: extractReturnType(handlerNode),
      },
    },
    callNodeId,
  };
}

export function createObjectLiteralHandlerNode(
  fileNodeId: string,
  handlerNode: SyntaxNode,
): { functionNode: GraphNode; callNodeId: string } | null {
  const pairNode = handlerNode.parent;
  const objectNode = pairNode?.parent;
  const argsNode = objectNode?.parent;
  const callExprNode = argsNode?.parent;
  if (!pairNode || !objectNode || !argsNode || !callExprNode) return null;

  const key = pairNode.childForFieldName("key");
  const propertyName = key ? normalizePropertyName(key) : "handler";
  const calleeText = callExprNode.childForFieldName("function")?.text ?? "unknown";
  const callParts = analyzeMemberCallExpression(calleeText);
  const expression = callParts?.expression ?? calleeText;
  const label = extractUrlOrPathProperty(objectNode)
    ?? argsNode.namedChildren.find((c) => c.type === "string")?.text.replace(/^["']|["']$/g, "");
  const syntheticName = label
    ? `<${expression}:${label}:${propertyName}>`
    : `<${expression}:${propertyName}>`;
  const row = callExprNode.startPosition.row + 1;
  const col = callExprNode.startPosition.column;
  const callNodeId = `${fileNodeId}:modulecall:${row}:${col}:${expression}`;

  return {
    functionNode: {
      id: `${fileNodeId}:function:${handlerNode.startPosition.row + 1}:${syntheticName}`,
      label: "Function",
      properties: {
        name: syntheticName,
        kind: handlerNode.type,
        methodKind: null,
        line: handlerNode.startPosition.row + 1,
        endLine: handlerNode.endPosition.row + 1,
        className: null,
        isExported: false,
        isAsync: handlerNode.children.some((c) => c.type === "async"),
        isAbstract: false,
        visibility: "public",
        parameters: extractFunctionParameters(handlerNode),
        returnType: extractReturnType(handlerNode),
      },
    },
    callNodeId,
  };
}

function isModuleLevelCallExpression(callExpr: SyntaxNode): boolean {
  const parent = callExpr.parent;
  if (parent?.type === "expression_statement") {
    return parent.parent?.type === "program";
  }
  if (parent?.type === "await_expression") {
    return parent.parent?.type === "expression_statement"
      && parent.parent.parent?.type === "program";
  }
  return false;
}

function extractUrlOrPathProperty(objectNode: SyntaxNode): string | null {
  for (const child of objectNode.namedChildren) {
    if (child.type !== "pair") continue;
    const key = child.childForFieldName("key");
    const value = child.childForFieldName("value");
    if (!key || value?.type !== "string") continue;
    if (normalizePropertyName(key) === "url" || normalizePropertyName(key) === "path") {
      return value.text.replace(/^["'`]|["'`]$/g, "");
    }
  }
  return null;
}

function normalizePropertyName(node: SyntaxNode): string {
  return node.type === "string" ? node.text.replace(/^["'`]|["'`]$/g, "") : node.text;
}

// Literal-ish arguments of a call or decorator as a JSON array: string contents,
// numbers, identifiers and member expressions; anything else is left out.
export function extractCallArgs(callExpr: SyntaxNode): string {
  const argsNode = callExpr.childForFieldName("arguments");
  if (!argsNode) return "[]";

  const args = argsNode.namedChildren
    .map((arg) => {
      if (arg.type === "string") return arg.text.replace(/^["'`]|["'`]$/g, "");
      if (arg.type === "number") return arg.text;
      if (arg.type === "identifier" || arg.type === "type_identifier") return arg.text;
      if (arg.type === "member_expression") return arg.text;
      return null;
    })
    .filter((v): v is string => v !== null);

  return JSON.stringify(args);
}

export function createModuleLevelCallNodes(fileNodeId: string, programNode: SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  for (const stmt of programNode.namedChildren) {
    if (stmt.type !== "expression_statement") continue;

    let expr = stmt.namedChildren[0];
    if (!expr) continue;

    if (expr.type === "await_expression") {
      expr = expr.namedChildren[0];
    }

    if (!expr) continue;

    if (expr.type === "call_expression") {
      const parts = analyzeCallFunction(expr.childForFieldName("function"));
      if (!parts) continue;

      calls.push({
        id: `${fileNodeId}:modulecall:${expr.startPosition.row + 1}:${expr.startPosition.column}:${parts.expression}`,
        label: "Call",
        properties: {
          name: parts.expression,
          expression: parts.expression,
          callee: parts.callee,
          receiver: parts.receiver,
          line: expr.startPosition.row + 1,
          columnNumber: expr.startPosition.column,
          args: extractCallArgs(expr),
          ...(parts.requireSource ? { requireSource: parts.requireSource } : {}),
        },
      });
    } else if (expr.type === "new_expression") {
      const parts = analyzeMemberCallExpression(expr.childForFieldName("constructor")?.text);
      if (!parts) continue;

      const expression = `new ${parts.expression}`;
      calls.push({
        id: `${fileNodeId}:modulecall:${expr.startPosition.row + 1}:${expr.startPosition.column}:${expression}`,
        label: "Call",
        properties: {
          name: expression,
          expression,
          callee: parts.callee,
          receiver: parts.receiver,
          line: expr.startPosition.row + 1,
          columnNumber: expr.startPosition.column,
          args: extractCallArgs(expr),
        },
      });
    }
  }

  return calls;
}

export function createInitializerCallNode(fileNodeId: string, valueNode: SyntaxNode): GraphNode | null {
  if (valueNode.type === "call_expression") {
    const parts = analyzeCallFunction(valueNode.childForFieldName("function"));
    if (!parts) return null;

    return {
      id: `${fileNodeId}:initializercall:${valueNode.startPosition.row + 1}:${valueNode.startPosition.column}:${parts.expression}`,
      label: "Call",
      properties: {
        name: parts.expression,
        expression: parts.expression,
        callee: parts.callee,
        receiver: parts.receiver,
        line: valueNode.startPosition.row + 1,
        columnNumber: valueNode.startPosition.column,
        args: extractCallArgs(valueNode),
        ...(parts.requireSource ? { requireSource: parts.requireSource } : {}),
      },
    };
  }

  if (valueNode.type === "new_expression") {
    const parts = analyzeMemberCallExpression(valueNode.childForFieldName("constructor")?.text);
    if (!parts) return null;

    const expression = `new ${parts.expression}`;
    return {
      id: `${fileNodeId}:initializercall:${valueNode.startPosition.row + 1}:${valueNode.startPosition.column}:${expression}`,
      label: "Call",
      properties: {
        name: expression,
        expression,
        callee: parts.callee,
        receiver: parts.receiver,
        line: valueNode.startPosition.row + 1,
        columnNumber: valueNode.startPosition.column,
        args: extractCallArgs(valueNode),
      },
    };
  }

  return null;
}

export function createCallNodes(
  functionNodeId: string,
  node: SyntaxNode,
  callbackKeys: ReadonlySet<string>,
): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type === "call_expression") {
      const parts = analyzeCallFunction(child.childForFieldName("function"));
      if (!parts) return;

      calls.push({
        id: `${functionNodeId}:call:${child.startPosition.row + 1}:${child.startPosition.column}:${parts.expression}`,
        label: "Call",
        properties: {
          name: parts.expression,
          expression: parts.expression,
          callee: parts.callee,
          receiver: parts.receiver,
          line: child.startPosition.row + 1,
          columnNumber: child.startPosition.column,
          args: extractCallArgs(child),
          ...(parts.requireSource ? { requireSource: parts.requireSource } : {}),
        },
      });
    } else if (child.type === "new_expression") {
      const parts = analyzeMemberCallExpression(child.childForFieldName("constructor")?.text);
      if (!parts) return;

      const expression = `new ${parts.expression}`;
      calls.push({
        id: `${functionNodeId}:call:${child.startPosition.row + 1}:${child.startPosition.column}:${expression}`,
        label: "Call",
        properties: {
          name: expression,
          expression,
          callee: parts.callee,
          receiver: parts.receiver,
          line: child.startPosition.row + 1,
          columnNumber: child.startPosition.column,
          args: extractCallArgs(child),
        },
      });
    }
  }, (candidate) => ownsCalls(candidate, callbackKeys));

  return calls;
}

// Functions that get a Function node of their own keep their calls. Anonymous
// callbacks such as forEach(el => …) or it('…', () => …) do not, so their calls
// belong to the enclosing function.
function ownsCalls(node: SyntaxNode, callbackKeys: ReadonlySet<string>): boolean {
  if (isClassNode(node) || isVariableClassValue(node)) return true;
  if (!isFunctionNode(node)) return false;
  if (moduleObjectPropertyFunctionName(node) !== null) return true;
  if (node.type === "method_definition" || node.type === "abstract_method_signature") {
    return node.parent?.type === "class_body";
  }
  if (extractName(node) !== null) return true;

  const declarator = node.parent;
  if (
    isVariableFunctionValue(node)
    && declarator?.type === "variable_declarator"
    && declarator.childForFieldName("name")?.type === "identifier"
  ) {
    return true;
  }

  return isInlineHandlerArgument(node)
    || isObjectLiteralHandlerFunction(node, callbackKeys)
    || isInitializerHandlerArgument(node)
    || scopedRouteHandlerOwner(node, callbackKeys) !== null;
}
