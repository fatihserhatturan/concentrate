import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../graph/model.js";
import type { LanguageParser } from "./types.js";
import {
  analyzeMemberCallExpression,
  createTreeSitterInput,
  walk,
  walkScoped,
} from "./tree-sitter-utils.js";

const parser = new Parser();
parser.setLanguage(Rust);

export const rustParser: LanguageParser = {
  language: "rust",
  parse: (rootPath, filePath) => parseRustFile(rootPath, filePath),
};

async function parseRustFile(rootPath: string, filePath: string): Promise<ParsedSourceFile> {
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
        language: "rust",
      },
    },
  ];
  const relationships: GraphRelationship[] = [];

  const tree = parser.parse(createTreeSitterInput(source));
  if (tree.rootNode.hasError) {
    throw new Error("Syntax error");
  }

  walk(tree.rootNode, (node) => {
    if (node.type === "use_declaration" || node.type === "mod_item") {
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

    if (node.type === "struct_item") {
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

  // Second pass: process functions now that all structs are indexed.
  const classesByName = new Map(
    nodes
      .filter((n) => n.label === "Class")
      .map((n) => [String(n.properties.name), n.id]),
  );

  walk(tree.rootNode, (node) => {
    if (node.type !== "function_item") return;

    const implTypeName = extractImplTypeName(node);
    const classNodeId = implTypeName ? classesByName.get(implTypeName) : undefined;
    const className = implTypeName ?? undefined;

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

function extractImplTypeName(node: Parser.SyntaxNode): string | null {
  if (node.parent?.type !== "declaration_list") return null;
  if (node.parent?.parent?.type !== "impl_item") return null;
  return node.parent.parent.childForFieldName("type")?.text ?? null;
}

function createImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const source = node.type === "mod_item"
    ? node.namedChildren.find((child) => child.type === "identifier")?.text
    : node.namedChildren[0]?.text;

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
  const name = node.childForFieldName("name")?.text
    ?? node.namedChildren.find((child) => child.type === "identifier")?.text
    ?? null;

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
      isExported: rustVisibility(node) !== "private",
      isAsync: node.namedChildren.some((c) => c.type === "function_modifiers" && c.children.some((fc) => fc.type === "async")),
      visibility: rustVisibility(node),
      parameters: null,
      returnType: null,
    },
  };
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
      isExported: rustVisibility(node) !== "private",
      visibility: rustVisibility(node),
    },
  };
}

function rustVisibility(node: Parser.SyntaxNode): string {
  const modifier = node.namedChildren.find((c) => c.type === "visibility_modifier")?.text;
  if (!modifier) {
    return "private";
  }

  if (modifier === "pub" || modifier === "pub(crate)" || modifier === "pub(super)") {
    return modifier;
  }

  return modifier.startsWith("pub") ? modifier : "private";
}

function createCallNodes(functionNodeId: string, node: Parser.SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type !== "call_expression" && child.type !== "macro_invocation") {
      return;
    }

    const expression = child.type === "macro_invocation"
      ? child.namedChildren.find((candidate) => candidate.type === "identifier")?.text
      : child.childForFieldName("function")?.text;
    const callExpression = analyzeMemberCallExpression(expression);
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
  }, (child) => child.type === "function_item");

  return calls;
}
