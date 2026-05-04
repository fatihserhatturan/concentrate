import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { SupportedLanguage } from "../../../core/scan/language.js";
import {
  createTreeSitterInput,
  walk,
} from "../tree-sitter-utils.js";
import {
  isClassNode,
  isFunctionNode,
  isModuleLevelDeclarator,
  isVariableClassValue,
  isVariableFunctionValue,
} from "./common.js";
import {
  createCjsImportNode,
  createDynamicImportNode,
  createImportNode,
  createReExportImportNode,
} from "./imports.js";
import {
  applyCjsExportBindings,
  createDefaultExportExpressionNode,
  createLocalReExportRelationships,
  extractCjsExportBindings,
  extractCjsObjectAssignExportBindings,
  extractLocalReExportNames,
  type CjsExportBinding,
} from "./exports.js";
import {
  appendClassMembers,
  createCallNodes,
  createInitializerCallNode,
  createInlineHandlerNode,
  createModuleLevelCallNodes,
  createObjectLiteralHandlerNode,
  createClassNode,
  createFunctionNode,
  createTypeScriptDeclarationNode,
  createVariableClassNode,
  createVariableFunctionNode,
  createVariableNode,
  isInlineHandlerArgument,
  isObjectLiteralHandlerFunction,
} from "./declarations.js";

const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

// ─── Walk state ──────────────────────────────────────────────────────────────

export type WalkState = {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  cjsExportBindings: CjsExportBinding[];
  localReExportNames: string[];
  functionAstPairs: Array<{ functionNodeId: string; astNode: Parser.SyntaxNode }>;
  variableDeclaratorAstNodes: Parser.SyntaxNode[];
};

// ─── Language-level walk ──────────────────────────────────────────────────────

export function walkJsTsNodes(
  fileNodeId: string,
  tree: Parser.Tree,
  language: SupportedLanguage,
): WalkState {
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const cjsExportBindings: CjsExportBinding[] = [];
  const localReExportNames: string[] = [];
  const functionAstPairs: Array<{ functionNodeId: string; astNode: Parser.SyntaxNode }> = [];
  const variableDeclaratorAstNodes: Parser.SyntaxNode[] = [];

  walk(tree.rootNode, (node) => {
    if (node.type === "import_statement") {
      const importNode = createImportNode(fileNodeId, node);
      if (importNode) {
        nodes.push(importNode);
        relationships.push({ from: fileNodeId, to: importNode.id, type: "IMPORTS", properties: {} });
      }
    }

    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "import") {
        const args = node.childForFieldName("arguments");
        const sourceNode = args?.namedChildren.find((c) => c.type === "string");
        if (sourceNode) {
          const source = sourceNode.text.replace(/^["']|["']$/g, "");
          const dynamicImportNode = createDynamicImportNode(fileNodeId, node, source);
          if (!nodes.some((n) => n.id === dynamicImportNode.id)) {
            nodes.push(dynamicImportNode);
            relationships.push({ from: fileNodeId, to: dynamicImportNode.id, type: "IMPORTS", properties: {} });
          }
        }
      }

      if (fn?.type === "identifier" && fn.text === "require") {
        const args = node.childForFieldName("arguments");
        const sourceNode = args?.namedChildren.find((c) => c.type === "string");
        if (sourceNode) {
          const source = sourceNode.text.replace(/^["']|["']$/g, "");
          const cjsImportNode = createCjsImportNode(fileNodeId, node, source, isConditionalRequire(node));
          if (!nodes.some((n) => n.id === cjsImportNode.id)) {
            nodes.push(cjsImportNode);
            relationships.push({ from: fileNodeId, to: cjsImportNode.id, type: "IMPORTS", properties: {} });
          }
        }
      }
    }

    if (node.type === "export_statement") {
      localReExportNames.push(...extractLocalReExportNames(node));

      const defaultExportNode = createDefaultExportExpressionNode(fileNodeId, node);
      if (defaultExportNode) {
        nodes.push(defaultExportNode);
        relationships.push({ from: fileNodeId, to: defaultExportNode.id, type: "DEFINES_VARIABLE", properties: {} });
      }

      const reExportNode = createReExportImportNode(fileNodeId, node);
      if (reExportNode) {
        nodes.push(reExportNode);
        relationships.push({ from: fileNodeId, to: reExportNode.id, type: "IMPORTS", properties: {} });
        if (reExportNode.properties.isWildcard === true) {
          relationships.push({ from: fileNodeId, to: reExportNode.id, type: "RE_EXPORTS", properties: {} });
        }
      }
    }

    if (node.type === "assignment_expression") {
      cjsExportBindings.push(...extractCjsExportBindings(node));
    }

    if (node.type === "call_expression") {
      cjsExportBindings.push(...extractCjsObjectAssignExportBindings(node));
    }

    if (isFunctionNode(node) && node.type !== "method_definition" && node.type !== "abstract_method_signature") {
      const functionNode = createFunctionNode(fileNodeId, node);
      if (functionNode) {
        nodes.push(functionNode);
        relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });

        const callNodes = createCallNodes(functionNode.id, node);
        nodes.push(...callNodes);
        relationships.push(...callNodes.map((c) => ({ from: functionNode.id, to: c.id, type: "CALLS" as const, properties: {} })));

        functionAstPairs.push({ functionNodeId: functionNode.id, astNode: node });
      } else if (isInlineHandlerArgument(node) || isObjectLiteralHandlerFunction(node)) {
        const result = isInlineHandlerArgument(node)
          ? createInlineHandlerNode(fileNodeId, node)
          : createObjectLiteralHandlerNode(fileNodeId, node);
        if (result) {
          nodes.push(result.functionNode);
          relationships.push({ from: fileNodeId, to: result.functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
          relationships.push({ from: result.functionNode.id, to: result.callNodeId, type: "PASSED_TO", properties: {} });

          const callNodes = createCallNodes(result.functionNode.id, node);
          nodes.push(...callNodes);
          relationships.push(...callNodes.map((c) => ({ from: result.functionNode.id, to: c.id, type: "CALLS" as const, properties: {} })));

          functionAstPairs.push({ functionNodeId: result.functionNode.id, astNode: node });
        }
      }
    }

    if (node.type === "variable_declarator") {
      const valueChild = node.childForFieldName("value");
      if (isVariableClassValue(valueChild)) {
        const classNode = createVariableClassNode(fileNodeId, node, valueChild!);
        if (classNode) {
          nodes.push(classNode);
          relationships.push({ from: fileNodeId, to: classNode.id, type: "DEFINES_CLASS", properties: {} });
          appendClassMembers(fileNodeId, classNode, valueChild!, nodes, relationships);
        }
      } else if (isVariableFunctionValue(valueChild)) {
        const functionNode = createVariableFunctionNode(fileNodeId, node, valueChild!);
        if (functionNode) {
          nodes.push(functionNode);
          relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
          const callNodes = createCallNodes(functionNode.id, valueChild!);
          nodes.push(...callNodes);
          relationships.push(...callNodes.map((c) => ({ from: functionNode.id, to: c.id, type: "CALLS" as const, properties: {} })));

          functionAstPairs.push({ functionNodeId: functionNode.id, astNode: valueChild! });
        }
      } else if (isModuleLevelDeclarator(node)) {
        const variableNode = createVariableNode(fileNodeId, node);
        if (variableNode) {
          nodes.push(variableNode);
          relationships.push({ from: fileNodeId, to: variableNode.id, type: "DEFINES_VARIABLE", properties: {} });

          if (valueChild?.type === "call_expression" || valueChild?.type === "new_expression") {
            const callNode = createInitializerCallNode(fileNodeId, valueChild);
            if (callNode) {
              nodes.push(callNode);
              relationships.push({ from: variableNode.id, to: callNode.id, type: "INITIALIZED_BY", properties: {} });
            }
          }

          variableDeclaratorAstNodes.push(node);
        }
      }
    }

    if (isClassNode(node)) {
      const classNode = createClassNode(fileNodeId, node);
      if (classNode) {
        nodes.push(classNode);
        relationships.push({ from: fileNodeId, to: classNode.id, type: "DEFINES_CLASS", properties: {} });
        appendClassMembers(fileNodeId, classNode, node, nodes, relationships);
      }
    }

    if (language === "typescript") {
      const typeDeclarationNode = createTypeScriptDeclarationNode(fileNodeId, node);
      if (typeDeclarationNode) {
        nodes.push(typeDeclarationNode.node);
        relationships.push({ from: fileNodeId, to: typeDeclarationNode.node.id, type: typeDeclarationNode.relationshipType, properties: {} });
      }
    }
  });

  return { nodes, relationships, cjsExportBindings, localReExportNames, functionAstPairs, variableDeclaratorAstNodes };
}

// ─── Language-level finalization ─────────────────────────────────────────────

export function finalizeLanguageLevel(
  fileNodeId: string,
  tree: Parser.Tree,
  state: WalkState,
): ParsedSourceFile {
  const { nodes, relationships, cjsExportBindings, localReExportNames } = state;

  applyCjsExportBindings(fileNodeId, nodes, relationships, cjsExportBindings);
  relationships.push(...createLocalReExportRelationships(fileNodeId, nodes, relationships, localReExportNames));

  const moduleLevelCallNodes = createModuleLevelCallNodes(fileNodeId, tree.rootNode);
  nodes.push(...moduleLevelCallNodes);
  relationships.push(...moduleLevelCallNodes.map((c) => ({ from: fileNodeId, to: c.id, type: "MODULE_CALLS" as const, properties: {} })));

  return { fileNodeId, nodes, relationships };
}

// ─── Public helpers ───────────────────────────────────────────────────────────

export function parseTree(source: string, language: SupportedLanguage): Parser.Tree {
  return (language === "typescript" ? tsParser : jsParser).parse(createTreeSitterInput(source));
}

// Language-only parse — no framework semantic nodes (routes, entrypoints, env/config).
export async function parseJsTsLanguageOnly(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;

  const fileNode: GraphNode = {
    id: fileNodeId,
    label: "File",
    properties: { path: filePath, relativePath, language },
  };

  const tree = parseTree(source, language);
  if (tree.rootNode.hasError) {
    throw new Error("Syntax error");
  }

  const state = walkJsTsNodes(fileNodeId, tree, language);
  state.nodes.unshift(fileNode);

  return finalizeLanguageLevel(fileNodeId, tree, state);
}

// Language-only parse that also returns the tree root node for framework
// module boundary tests that need to call applyXxxParseSemantics directly.
export async function parseJsTsWithRootNode(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<{ parsed: ParsedSourceFile; rootNode: Parser.SyntaxNode }> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;

  const fileNode: GraphNode = {
    id: fileNodeId,
    label: "File",
    properties: { path: filePath, relativePath, language },
  };

  const tree = parseTree(source, language);
  if (tree.rootNode.hasError) {
    throw new Error("Syntax error");
  }

  const state = walkJsTsNodes(fileNodeId, tree, language);
  state.nodes.unshift(fileNode);

  return { parsed: finalizeLanguageLevel(fileNodeId, tree, state), rootNode: tree.rootNode };
}

function isConditionalRequire(node: Parser.SyntaxNode): boolean {
  let current = node.parent;
  while (current && current.type !== "program") {
    if (
      current.type === "if_statement"
      || current.type === "conditional_expression"
      || current.type === "switch_case"
      || current.type === "switch_default"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}
