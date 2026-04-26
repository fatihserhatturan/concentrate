import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../graph/model.js";
import type { SupportedLanguage } from "../scanner/language.js";
import type { LanguageParser } from "./types.js";
import {
  analyzeMemberCallExpression,
  createTreeSitterInput,
  walk,
  walkScoped,
} from "./tree-sitter-utils.js";

const parser = new Parser();
parser.setLanguage(Python);

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

  const tree = parser.parse(createTreeSitterInput(source));
  if (tree.rootNode.hasError) {
    throw new Error("Syntax error");
  }

  walk(tree.rootNode, (node) => {
    if (node.type === "import_statement" || node.type === "import_from_statement") {
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

  return { fileNodeId, nodes, relationships };
}

function createImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const source = node.type === "import_from_statement"
    ? extractImportFromSource(node)
    : extractImportStatementSource(node);

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

function extractImportFromSource(node: Parser.SyntaxNode): string | null {
  const relativeImport = node.namedChildren.find((child) => child.type === "relative_import");
  if (relativeImport) {
    return normalizePythonRelativeImport(relativeImport.text, getImportedName(node));
  }

  const dottedName = node.namedChildren.find((child) => child.type === "dotted_name");
  return dottedName?.text ?? null;
}

function getImportedName(node: Parser.SyntaxNode): string | null {
  const importSourceNode = node.namedChildren.find((child) => (
    child.type === "relative_import" || child.type === "dotted_name"
  ));
  const importSourceIndex = importSourceNode ? node.namedChildren.indexOf(importSourceNode) : -1;
  const importedName = node.namedChildren
    .slice(importSourceIndex + 1)
    .find((child) => child.type === "dotted_name" || child.type === "aliased_import");

  if (!importedName) {
    return null;
  }

  const dottedName = importedName.type === "aliased_import"
    ? importedName.namedChildren.find((child) => child.type === "dotted_name")
    : importedName;

  return dottedName?.text ?? null;
}

function extractImportStatementSource(node: Parser.SyntaxNode): string | null {
  const firstImport = node.namedChildren.find((child) => (
    child.type === "dotted_name" || child.type === "aliased_import"
  ));

  if (!firstImport) {
    return null;
  }

  const dottedName = firstImport.type === "aliased_import"
    ? firstImport.namedChildren.find((child) => child.type === "dotted_name")
    : firstImport;

  return dottedName?.text ?? null;
}

function normalizePythonRelativeImport(source: string, importedName: string | null): string {
  const dotCount = source.match(/^\.+/)?.[0].length ?? 0;
  const modulePath = source.slice(dotCount).replaceAll(".", "/");
  const parentPrefix = dotCount <= 1 ? "." : [".", ...Array.from({ length: dotCount - 1 }, () => "..")].join("/");
  const importedPath = importedName?.replaceAll(".", "/") ?? null;

  if (modulePath) {
    return `${parentPrefix}/${modulePath}`;
  }

  return importedPath ? `${parentPrefix}/${importedPath}` : parentPrefix;
}

function isPythonClassMethod(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === "block" && node.parent?.parent?.type === "class_definition";
}

function createFunctionNode(fileNodeId: string, node: Parser.SyntaxNode, className?: string): GraphNode | null {
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
      className: className ?? null,
      isExported: !name.startsWith("_"),
      isAsync: node.children.some((c) => c.type === "async"),
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
      isExported: !name.startsWith("_"),
      extendsNames: serializeNameList(extractPythonBaseClassNames(node)),
      implementsNames: null,
    },
  };
}

function extractPythonBaseClassNames(node: Parser.SyntaxNode): string[] {
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

function createCallNodes(functionNodeId: string, node: Parser.SyntaxNode): GraphNode[] {
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

function extractName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}
