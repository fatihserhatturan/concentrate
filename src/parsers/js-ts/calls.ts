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

export function createCallNodes(functionNodeId: string, node: Parser.SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type !== "call_expression") {
      return;
    }

    const callExpression = analyzeMemberCallExpression(child.childForFieldName("function")?.text);
    if (!callExpression) {
      return;
    }

    calls.push({
      id: `${functionNodeId}:call:${child.startPosition.row + 1}:${child.startPosition.column}:${callExpression.expression}`,
      label: "Call",
      properties: {
        name: callExpression.expression,
        expression: callExpression.expression,
        callee: callExpression.callee,
        receiver: callExpression.receiver,
        line: child.startPosition.row + 1,
        columnNumber: child.startPosition.column,
      },
    });
  }, (child) => isFunctionNode(child) || isClassNode(child) || isVariableClassValue(child));

  return calls;
}
