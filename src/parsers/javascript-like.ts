import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../graph/model.js";
import type { SupportedLanguage } from "../scanner/language.js";
import type { LanguageParser } from "./types.js";
import {
  analyzeMemberCallExpression,
  createTreeSitterInput,
  walk,
  walkScoped,
} from "./tree-sitter-utils.js";

const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

export const javascriptParser: LanguageParser = {
  language: "javascript",
  parse: (rootPath, filePath) => parseJavaScriptLikeFile(rootPath, filePath, "javascript"),
};

export const typescriptParser: LanguageParser = {
  language: "typescript",
  parse: (rootPath, filePath) => parseJavaScriptLikeFile(rootPath, filePath, "typescript"),
};

async function parseJavaScriptLikeFile(
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

  const tree = (language === "typescript" ? tsParser : jsParser).parse(createTreeSitterInput(source));
  if (tree.rootNode.hasError) {
    throw new Error("Syntax error");
  }

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

    if (node.type === "export_statement") {
      const reExportNode = createReExportImportNode(fileNodeId, node);
      if (reExportNode) {
        nodes.push(reExportNode);
        relationships.push({
          from: fileNodeId,
          to: reExportNode.id,
          type: "IMPORTS",
          properties: {},
        });

        if (reExportNode.properties.isWildcard === true) {
          relationships.push({
            from: fileNodeId,
            to: reExportNode.id,
            type: "RE_EXPORTS",
            properties: {},
          });
        }
      }
    }

    if (isFunctionNode(node) && node.type !== "method_definition") {
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

    if (node.type === "variable_declarator") {
      const valueChild = node.childForFieldName("value");
      if (isVariableFunctionValue(valueChild)) {
        const functionNode = createVariableFunctionNode(fileNodeId, node, valueChild!);
        if (functionNode) {
          nodes.push(functionNode);
          relationships.push({
            from: fileNodeId,
            to: functionNode.id,
            type: "DEFINES_FUNCTION",
            properties: {},
          });

          const callNodes = createCallNodes(functionNode.id, valueChild!);
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

        const className = String(classNode.properties.name);
        const classBody = node.childForFieldName("body");
        if (classBody) {
          for (const child of classBody.namedChildren) {
            if (child.type !== "method_definition") continue;
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

    if (language === "typescript") {
      const typeDeclarationNode = createTypeScriptDeclarationNode(fileNodeId, node);
      if (typeDeclarationNode) {
        nodes.push(typeDeclarationNode.node);
        relationships.push({
          from: fileNodeId,
          to: typeDeclarationNode.node.id,
          type: typeDeclarationNode.relationshipType,
          properties: {},
        });
      }
    }
  });

  return { fileNodeId, nodes, relationships };
}

function isFunctionNode(node: Parser.SyntaxNode): boolean {
  return [
    "function_declaration",
    "method_definition",
    "generator_function_declaration",
    "arrow_function",
    "function_expression",
  ].includes(node.type);
}

function isVariableFunctionValue(node: Parser.SyntaxNode | null | undefined): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression";
}

function createVariableFunctionNode(
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
      line: declarator.startPosition.row + 1,
      endLine: valueNode.endPosition.row + 1,
      className: null,
      isExported: declarator.parent?.parent?.type === "export_statement",
      isAsync: valueNode.children.some((c) => c.type === "async"),
      visibility: "public",
    },
  };
}

function createImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const source = extractStringSource(node);

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
      isReExport: false,
      isWildcard: false,
    },
  };
}

function createReExportImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const source = extractStringSource(node);
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
      isReExport: true,
      isWildcard: isWildcardReExport(node),
    },
  };
}

function extractStringSource(node: Parser.SyntaxNode): string | null {
  return node
    .namedChildren
    .find((child) => child.type === "string")?.text
    .replace(/^["']|["']$/g, "") ?? null;
}

function isWildcardReExport(node: Parser.SyntaxNode): boolean {
  return /^export\s+\*/.test(node.text);
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
      isExported: node.parent?.type === "export_statement",
      isAsync: node.children.some((c) => c.type === "async"),
      visibility: extractTypeScriptVisibility(node),
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
      isExported: node.parent?.type === "export_statement",
      visibility: extractTypeScriptVisibility(node),
      extendsNames: serializeNameList(extractTypeScriptExtendsNames(node)),
      implementsNames: serializeNameList(extractTypeScriptImplementsNames(node)),
    },
  };
}

function extractTypeScriptVisibility(node: Parser.SyntaxNode): string {
  const modifier = node.children.find((child) => child.type === "accessibility_modifier")?.text;
  return modifier === "private" || modifier === "protected" ? modifier : "public";
}

function extractTypeScriptExtendsNames(node: Parser.SyntaxNode): string[] {
  const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
  const extendsClause = heritage?.namedChildren.find((child) => child.type === "extends_clause");
  return extendsClause ? extractTypeNames(extendsClause) : [];
}

function extractTypeScriptImplementsNames(node: Parser.SyntaxNode): string[] {
  const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
  const implementsClause = heritage?.namedChildren.find((child) => child.type === "implements_clause");
  return implementsClause ? extractTypeNames(implementsClause) : [];
}

function extractTypeNames(node: Parser.SyntaxNode): string[] {
  return node.namedChildren
    .filter((child) => (
      child.type === "identifier"
      || child.type === "type_identifier"
      || child.type === "nested_type_identifier"
      || child.type === "generic_type"
    ))
    .map((child) => child.text);
}

function serializeNameList(names: string[]): string | null {
  return names.length > 0 ? JSON.stringify(names) : null;
}

function createTypeScriptDeclarationNode(
  fileNodeId: string,
  node: Parser.SyntaxNode,
): { node: GraphNode; relationshipType: GraphRelationship["type"] } | null {
  const declaration = typeScriptDeclarationMetadata(node.type);
  if (!declaration) {
    return null;
  }

  const name = extractName(node);
  if (!name) {
    return null;
  }

  return {
    node: {
      id: `${fileNodeId}:${declaration.idSegment}:${node.startPosition.row + 1}:${name}`,
      label: declaration.label,
      properties: {
        name,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isExported: node.parent?.type === "export_statement",
      },
    },
    relationshipType: declaration.relationshipType,
  };
}

function typeScriptDeclarationMetadata(nodeType: string): {
  idSegment: string;
  label: GraphNode["label"];
  relationshipType: GraphRelationship["type"];
} | null {
  switch (nodeType) {
    case "interface_declaration":
      return {
        idSegment: "interface",
        label: "Interface",
        relationshipType: "DEFINES_INTERFACE",
      };
    case "type_alias_declaration":
      return {
        idSegment: "type-alias",
        label: "TypeAlias",
        relationshipType: "DEFINES_TYPE_ALIAS",
      };
    case "enum_declaration":
      return {
        idSegment: "enum",
        label: "Enum",
        relationshipType: "DEFINES_ENUM",
      };
    default:
      return null;
  }
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
  }, (child) => isFunctionNode(child) || child.type === "class_declaration");

  return calls;
}

function extractName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}
