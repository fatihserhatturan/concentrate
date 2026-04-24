import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../graph/model.js";
import type { SupportedLanguage } from "../scanner/language.js";

const parser = new Parser();

export async function parseJavaScriptLikeFile(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<ParsedSourceFile> {
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
        language,
      },
    },
  ];
  const relationships: GraphRelationship[] = [];

  parser.setLanguage(language === "typescript" ? TypeScript.typescript : JavaScript);
  const tree = parser.parse(source);

  walk(tree.rootNode, (node) => {
    if (node.type === "import_statement") {
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

    if (isFunctionNode(node)) {
      const functionNode = createFunctionNode(fileNodeId, node);
      if (functionNode) {
        nodes.push(functionNode);
        relationships.push({
          from: fileNodeId,
          to: functionNode.id,
          type: "DEFINES_FUNCTION",
          properties: {},
        });

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
      }
    }

    if (node.type === "class_declaration") {
      const classNode = createClassNode(fileNodeId, node);
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

  return { fileNodeId, nodes, relationships };
}

function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

function isFunctionNode(node: Parser.SyntaxNode): boolean {
  return [
    "function_declaration",
    "method_definition",
    "generator_function_declaration",
  ].includes(node.type);
}

function createImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const source = node
    .namedChildren
    .find((child) => child.type === "string")?.text
    .replace(/^["']|["']$/g, "");

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

function createFunctionNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
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
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    },
  };
}

function createClassNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const name = extractName(node);
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
    },
  };
}

function createCallNodes(functionNodeId: string, node: Parser.SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  walk(node, (child) => {
    if (child.type !== "call_expression") {
      return;
    }

    const name = child.childForFieldName("function")?.text;
    if (!name) {
      return;
    }

    calls.push({
      id: `${functionNodeId}:call:${child.startPosition.row + 1}:${child.startPosition.column}:${name}`,
      label: "Call",
      properties: {
        name,
        line: child.startPosition.row + 1,
      },
    });
  });

  return calls;
}

function extractName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}
