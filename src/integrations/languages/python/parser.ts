import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTreeSkippingErrors, type SyntaxNode } from "../syntax/tree-sitter.js";
import { createPythonImportNodes, readDunderAll } from "./imports.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { SupportedLanguage } from "../../../core/scan/language.js";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import {
  analyzeMemberCallExpression,
  walk,
  walkScoped,
} from "../tree-sitter-utils.js";

// Node types whose children are statements: one with a syntax error is left
// out on its own, and the rest of the file is kept. A broken `def` header makes
// the grammar wrap the statements around it in one ERROR node, whose children
// are statements as well.
const statementParents = new Set(["module", "block", "ERROR"]);

export const pythonParser: LanguageParser = {
  language: "python",
  parse: (rootPath, filePath) => parsePythonFile(rootPath, filePath, "python"),
};

async function parsePythonFile(
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

  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors("python", source, statementParents);
  try {
    const importIds = new Set<string>();
    const allNames = readDunderAll(tree.rootNode);
    if (allNames) nodes[0]!.properties.allNames = JSON.stringify(allNames);

    walk(tree.rootNode, (node) => {
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        for (const importNode of createPythonImportNodes(fileNodeId, node, importIds)) {
          nodes.push(importNode);
          relationships.push({
            from: fileNodeId,
            to: importNode.id,
            type: "IMPORTS",
            properties: {},
          });
        }
      }

      if (node.type === "function_definition" && !isPythonClassMethod(node)) {
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

      if (node.type === "class_definition") {
        const classNode = createClassNode(fileNodeId, node);
        if (classNode) {
          nodes.push(classNode);
          relationships.push({
            from: fileNodeId,
            to: classNode.id,
            type: "DEFINES_CLASS",
            properties: {},
          });

          const className = String(classNode.properties.name);
          const body = node.namedChildren.find((c) => c.type === "block");
          if (body) {
            for (const child of body.namedChildren) {
              if (child.type !== "function_definition") continue;
              const methodNode = createFunctionNode(fileNodeId, child, className);
              if (methodNode) {
                nodes.push(methodNode);
                relationships.push({
                  from: classNode.id,
                  to: methodNode.id,
                  type: "DEFINES_METHOD",
                  properties: {},
                });
                const callNodes = createCallNodes(methodNode.id, child);
                nodes.push(...callNodes);
                relationships.push(
                  ...callNodes.map((callNode) => ({
                    from: methodNode.id,
                    to: callNode.id,
                    type: "CALLS" as const,
                    properties: {},
                  })),
                );
              }
            }
          }
        }
      }
    });

    const parsed: ParsedSourceFile = { fileNodeId, nodes, relationships };
    if (skippedLines.length > 0) {
      parsed.warnings = [`Syntax error: left out the statement${skippedLines.length === 1 ? "" : "s"} at line${skippedLines.length === 1 ? "" : "s"} ${skippedLines.join(", ")}`];
    }
    return parsed;
  } finally {
    tree.delete();
  }
}

function isPythonClassMethod(node: SyntaxNode): boolean {
  return node.parent?.type === "block" && node.parent?.parent?.type === "class_definition";
}

function createFunctionNode(fileNodeId: string, node: SyntaxNode, className?: string): GraphNode | null {
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
      methodKind: null,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      className: className ?? null,
      isExported: !name.startsWith("_"),
      isAsync: node.children.some((c) => c.type === "async"),
      isAbstract: false,
      visibility: pythonVisibility(name),
      parameters: null,
      returnType: null,
    },
  };
}

function createClassNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
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
      isExported: !name.startsWith("_"),
      isAbstract: false,
      visibility: pythonVisibility(name),
      extendsNames: serializeNameList(extractPythonBaseClassNames(node)),
      implementsNames: null,
    },
  };
}

function pythonVisibility(name: string): string {
  if (name.startsWith("__")) {
    return "dunder";
  }
  return name.startsWith("_") ? "private" : "public";
}

function extractPythonBaseClassNames(node: SyntaxNode): string[] {
  const argumentList = node.namedChildren.find((child) => child.type === "argument_list");
  if (!argumentList) {
    return [];
  }

  return argumentList.namedChildren
    .filter((child) => child.type === "identifier" || child.type === "attribute")
    .map((child) => child.text);
}

function serializeNameList(names: string[]): string | null {
  return names.length > 0 ? JSON.stringify(names) : null;
}

function createCallNodes(functionNodeId: string, node: SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type !== "call") {
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
  }, (child) => child.type === "function_definition" || child.type === "class_definition");

  return calls;
}

function extractName(node: SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}
