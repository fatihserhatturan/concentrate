import type Parser from "tree-sitter";
import type { GraphNode } from "../../../core/graph/model.js";
import {
  extractName,
  extractTypeScriptVisibility,
  isTypeScriptAbstract,
} from "./common.js";
import {
  extractFunctionParameters,
  extractMethodKind,
  extractReturnType,
} from "./function-signature.js";

export function createVariableFunctionNode(
  fileNodeId: string,
  declarator: Parser.SyntaxNode,
  valueNode: Parser.SyntaxNode,
): GraphNode | null {
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode || nameNode.type !== "identifier") {
    return null;
  }

  return {
    id: `${fileNodeId}:function:${declarator.startPosition.row + 1}:${nameNode.text}`,
    label: "Function",
    properties: {
      name: nameNode.text,
      kind: valueNode.type,
      methodKind: null,
      line: declarator.startPosition.row + 1,
      endLine: valueNode.endPosition.row + 1,
      className: null,
      isExported: declarator.parent?.parent?.type === "export_statement",
      isAsync: valueNode.children.some((c) => c.type === "async"),
      isAbstract: false,
      visibility: "public",
      parameters: extractFunctionParameters(valueNode),
      returnType: extractReturnType(valueNode),
    },
  };
}

export function createFunctionNode(fileNodeId: string, node: Parser.SyntaxNode, className?: string): GraphNode | null {
  const name = extractName(node);
  if (!name) {
    return null;
  }

  return {
    id: `${fileNodeId}:function:${node.startPosition.row + 1}:${name}`,
    label: "Function",
    properties: {
      name,
      kind: node.type,
      methodKind: extractMethodKind(node),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      className: className ?? null,
      isExported: node.parent?.type === "export_statement",
      isAsync: node.children.some((c) => c.type === "async"),
      isAbstract: isTypeScriptAbstract(node),
      visibility: extractTypeScriptVisibility(node),
      parameters: extractFunctionParameters(node),
      returnType: extractReturnType(node),
    },
  };
}
