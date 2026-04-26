import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../graph/model.js";
import type { LanguageParser } from "./types.js";
import {
  analyzeMemberCallExpression,
  createTreeSitterInput,
  walk,
  walkScoped,
} from "./tree-sitter-utils.js";

const parser = new Parser();
parser.setLanguage(Go);

export const goParser: LanguageParser = {
  language: "go",
  parse: (rootPath, filePath) => parseGoFile(rootPath, filePath),
};

async function parseGoFile(rootPath: string, filePath: string): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const nodes: GraphNode[] = [
    {
      id: fileNodeId,
      label: "File",
      properties: {
        path: filePath,
        relativePath,
        language: "go",
      },
    },
  ];
  const relationships: GraphRelationship[] = [];

  const tree = parser.parse(createTreeSitterInput(source));
  if (tree.rootNode.hasError) {
    throw new Error("Syntax error");
  }

  walk(tree.rootNode, (node) => {
    if (node.type === "import_spec") {
      const importNode = createImportNode(fileNodeId, node);
      if (importNode) {
        nodes.push(importNode);
        relationships.push({
          from: fileNodeId,
          to: importNode.id,
          type: "IMPORTS",
          properties: {},
        });
      }
    }

    if (node.type === "type_spec" && node.namedChildren.some((child) => child.type === "struct_type")) {
      const classNode = createStructNode(fileNodeId, node);
      if (classNode) {
        nodes.push(classNode);
        relationships.push({
          from: fileNodeId,
          to: classNode.id,
          type: "DEFINES_CLASS",
          properties: {},
        });
      }
    }
  });

  // Second pass: process functions and methods now that all structs are indexed.
  const classesByName = new Map(
    nodes
      .filter((n) => n.label === "Class")
      .map((n) => [String(n.properties.name), n.id]),
  );

  walk(tree.rootNode, (node) => {
    if (node.type !== "function_declaration" && node.type !== "method_declaration") return;

    const receiverTypeName = node.type === "method_declaration"
      ? extractGoReceiverTypeName(node)
      : null;
    const classNodeId = receiverTypeName ? classesByName.get(receiverTypeName) : undefined;
    const className = receiverTypeName ?? undefined;

    const functionNode = createFunctionNode(fileNodeId, node, className);
    if (!functionNode) return;

    nodes.push(functionNode);

    if (classNodeId) {
      relationships.push({ from: classNodeId, to: functionNode.id, type: "DEFINES_METHOD", properties: {} });
    } else {
      relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
    }

    const callNodes = createCallNodes(functionNode.id, node);
    nodes.push(...callNodes);
    relationships.push(
      ...callNodes.map((callNode) => ({
        from: functionNode.id,
        to: callNode.id,
        type: "CALLS" as const,
        properties: {},
      })),
    );
  });

  return { fileNodeId, nodes, relationships };
}

function createImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const source = node
    .namedChildren
    .find((child) => child.type === "interpreted_string_literal" || child.type === "raw_string_literal")
    ?.text
    .replace(/^["`]|["`]$/g, "");

  if (!source) {
    return null;
  }

  return {
    id: `${fileNodeId}:import:${node.startPosition.row + 1}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: node.text,
      line: node.startPosition.row + 1,
    },
  };
}

function createFunctionNode(fileNodeId: string, node: Parser.SyntaxNode, className?: string): GraphNode | null {
  const name = extractFunctionName(node);
  if (!name) {
    return null;
  }

  return {
    id: `${fileNodeId}:function:${node.startPosition.row + 1}:${name}`,
    label: "Function",
    properties: {
      name,
      kind: node.type,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      className: className ?? null,
      isExported: /^[A-Z]/.test(name),
      isAsync: false,
    },
  };
}

function extractGoReceiverTypeName(node: Parser.SyntaxNode): string | null {
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return null;

  for (const param of receiver.namedChildren) {
    if (param.type !== "parameter_declaration") continue;
    for (const typeChild of param.namedChildren) {
      if (typeChild.type === "type_identifier") return typeChild.text;
      if (typeChild.type === "pointer_type") {
        const ti = typeChild.namedChildren.find((c) => c.type === "type_identifier");
        if (ti) return ti.text;
      }
    }
  }
  return null;
}

function createStructNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const name = node.childForFieldName("name")?.text
    ?? node.namedChildren.find((child) => child.type === "type_identifier")?.text
    ?? null;

  if (!name) {
    return null;
  }

  return {
    id: `${fileNodeId}:class:${node.startPosition.row + 1}:${name}`,
    label: "Class",
    properties: {
      name,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: /^[A-Z]/.test(name),
    },
  };
}

function createCallNodes(functionNodeId: string, node: Parser.SyntaxNode): GraphNode[] {
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
  }, (child) => child.type === "function_declaration" || child.type === "method_declaration");

  return calls;
}

function extractFunctionName(node: Parser.SyntaxNode): string | null {
  if (node.type === "method_declaration") {
    return node.namedChildren.find((child) => child.type === "field_identifier")?.text ?? null;
  }

  return node.childForFieldName("name")?.text
    ?? node.namedChildren.find((child) => child.type === "identifier")?.text
    ?? null;
}
