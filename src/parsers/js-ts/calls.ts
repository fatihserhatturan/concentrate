import type Parser from "tree-sitter";
import type { GraphNode } from "../../graph/model.js";
import {
  analyzeMemberCallExpression,
  walkScoped,
} from "../tree-sitter-utils.js";
import {
  isClassNode,
  isFunctionNode,
  isVariableClassValue,
} from "./common.js";
import {
  extractFunctionParameters,
  extractReturnType,
} from "./function-signature.js";

export function isInlineHandlerArgument(node: Parser.SyntaxNode): boolean {
  if (node.type !== "arrow_function" && node.type !== "function_expression") return false;
  if (node.parent?.type !== "arguments") return false;
  const callExpr = node.parent.parent;
  if (!callExpr || callExpr.type !== "call_expression") return false;
  return isModuleLevelCallExpression(callExpr);
}

export function createInlineHandlerNode(
  fileNodeId: string,
  handlerNode: Parser.SyntaxNode,
): { functionNode: GraphNode; callNodeId: string } | null {
  const argsNode = handlerNode.parent;
  const callExprNode = argsNode?.parent;
  if (!argsNode || !callExprNode) return null;

  const calleeText = callExprNode.childForFieldName("function")?.text ?? "unknown";
  const callParts = analyzeMemberCallExpression(calleeText);
  const expression = callParts?.expression ?? calleeText;

  const routePath = argsNode.namedChildren
    .find((c) => c.type === "string")
    ?.text.replace(/^["']|["']$/g, "");

  const argIndex = argsNode.namedChildren.indexOf(handlerNode);
  const syntheticName = routePath
    ? `<${expression}:${routePath}:arg${argIndex}>`
    : `<${expression}:arg${argIndex}>`;

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

function isModuleLevelCallExpression(callExpr: Parser.SyntaxNode): boolean {
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

export function createModuleLevelCallNodes(fileNodeId: string, programNode: Parser.SyntaxNode): GraphNode[] {
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
      const parts = analyzeMemberCallExpression(expr.childForFieldName("function")?.text);
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
        },
      });
    }
  }

  return calls;
}

export function createInitializerCallNode(fileNodeId: string, valueNode: Parser.SyntaxNode): GraphNode | null {
  if (valueNode.type === "call_expression") {
    const parts = analyzeMemberCallExpression(valueNode.childForFieldName("function")?.text);
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
      },
    };
  }

  return null;
}

export function createCallNodes(functionNodeId: string, node: Parser.SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type === "call_expression") {
      const parts = analyzeMemberCallExpression(child.childForFieldName("function")?.text);
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
        },
      });
    }
  }, (child) => isFunctionNode(child) || isClassNode(child) || isVariableClassValue(child));

  return calls;
}
