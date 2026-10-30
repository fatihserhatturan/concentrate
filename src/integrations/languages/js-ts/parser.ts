import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTree, parseSyntaxTreeSkippingErrors, type GrammarName, type SyntaxNode, type SyntaxTree } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { SupportedLanguage } from "../../../core/scan/language.js";
import {
  walk,
} from "../tree-sitter-utils.js";
import {
  isClassNode,
  isFunctionNode,
  isModuleLevelDeclarator,
  isVariableClassValue,
  isVariableFunctionValue,
  moduleObjectPropertyFunctionName,
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
  extractCjsDefaultExport,
  extractDefaultExportName,
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
  isInitializerHandlerArgument,
  isInlineHandlerArgument,
  isObjectLiteralHandlerFunction,
  scopedRouteHandlerOwner,
} from "./declarations.js";

// ─── Walk state ──────────────────────────────────────────────────────────────

export type WalkState = {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  cjsExportBindings: CjsExportBinding[];
  localReExportNames: string[];
  defaultExportName: string | null;
  // `module.exports = require("./x")`: the default export is that module's.
  defaultExportFrom: string | null;
  functionAstPairs: Array<{ functionNodeId: string; astNode: SyntaxNode }>;
  variableDeclaratorAstNodes: SyntaxNode[];
};

// ─── Language-level walk ──────────────────────────────────────────────────────

export function walkJsTsNodes(
  fileNodeId: string,
  tree: SyntaxTree,
  language: SupportedLanguage,
  callbackKeys: ReadonlySet<string> = new Set(),
): WalkState {
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const cjsExportBindings: CjsExportBinding[] = [];
  const localReExportNames: string[] = [];
  let defaultExportName: string | null = null;
  let defaultExportFrom: string | null = null;
  const functionAstPairs: Array<{ functionNodeId: string; astNode: SyntaxNode }> = [];
  const variableDeclaratorAstNodes: SyntaxNode[] = [];

  // An inline function with a synthetic Function node, passed to a call.
  const addInlineHandler = (result: { functionNode: GraphNode; callNodeId: string }, node: SyntaxNode) => {
    nodes.push(result.functionNode);
    relationships.push({ from: fileNodeId, to: result.functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
    relationships.push({ from: result.functionNode.id, to: result.callNodeId, type: "PASSED_TO", properties: {} });

    const callNodes = createCallNodes(result.functionNode.id, node, callbackKeys);
    nodes.push(...callNodes);
    relationships.push(...callNodes.map((c) => ({ from: result.functionNode.id, to: c.id, type: "CALLS" as const, properties: {} })));

    functionAstPairs.push({ functionNodeId: result.functionNode.id, astNode: node });
  };

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
      defaultExportName ??= extractDefaultExportName(node);

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
      const cjsDefault = defaultExportName || defaultExportFrom ? null : extractCjsDefaultExport(node);
      if (cjsDefault && "name" in cjsDefault) defaultExportName = cjsDefault.name;
      if (cjsDefault && "from" in cjsDefault) defaultExportFrom = cjsDefault.from;
    }

    if (node.type === "call_expression") {
      cjsExportBindings.push(...extractCjsObjectAssignExportBindings(node));
    }

    if (isFunctionNode(node) && node.type !== "abstract_method_signature" && (node.type !== "method_definition" || node.parent?.type === "object")) {
      // Functions of module-level object literals are named by their property.
      const propertyName = moduleObjectPropertyFunctionName(node);
      const functionNode = node.type === "method_definition"
        ? propertyName ? createFunctionNode(fileNodeId, node, undefined, propertyName) : null
        : createFunctionNode(fileNodeId, node) ?? (propertyName ? createFunctionNode(fileNodeId, node, undefined, propertyName) : null);
      if (functionNode) {
        nodes.push(functionNode);
        relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });

        const callNodes = createCallNodes(functionNode.id, node, callbackKeys);
        nodes.push(...callNodes);
        relationships.push(...callNodes.map((c) => ({ from: functionNode.id, to: c.id, type: "CALLS" as const, properties: {} })));

        functionAstPairs.push({ functionNodeId: functionNode.id, astNode: node });
      } else if (isInlineHandlerArgument(node) || isObjectLiteralHandlerFunction(node, callbackKeys) || isInitializerHandlerArgument(node)) {
        const result = isInlineHandlerArgument(node)
          ? createInlineHandlerNode(fileNodeId, node)
          : isInitializerHandlerArgument(node)
            ? createInlineHandlerNode(fileNodeId, node, "initializercall")
            : createObjectLiteralHandlerNode(fileNodeId, node);
        if (result) addInlineHandler(result, node);
      } else {
        // The walk visits a function before the functions inside it, so the
        // owner's node (if it has one) is already known.
        const owner = scopedRouteHandlerOwner(node, callbackKeys);
        const ownerId = owner && (functionAstPairs.find((pair) => pair.astNode.id === owner.id)?.functionNodeId ?? fileNodeId);
        const result = ownerId ? createInlineHandlerNode(fileNodeId, node, "call", ownerId) : null;
        if (result) addInlineHandler(result, node);
      }
    }

    if (node.type === "variable_declarator") {
      const valueChild = node.childForFieldName("value");
      if (isVariableClassValue(valueChild)) {
        const classNode = createVariableClassNode(fileNodeId, node, valueChild!);
        if (classNode) {
          nodes.push(classNode);
          relationships.push({ from: fileNodeId, to: classNode.id, type: "DEFINES_CLASS", properties: {} });
          appendClassMembers(fileNodeId, classNode, valueChild!, nodes, relationships, callbackKeys, functionAstPairs);
        }
      } else if (isVariableFunctionValue(valueChild)) {
        const functionNode = createVariableFunctionNode(fileNodeId, node, valueChild!);
        if (functionNode) {
          nodes.push(functionNode);
          relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
          const callNodes = createCallNodes(functionNode.id, valueChild!, callbackKeys);
          nodes.push(...callNodes);
          relationships.push(...callNodes.map((c) => ({ from: functionNode.id, to: c.id, type: "CALLS" as const, properties: {} })));

          functionAstPairs.push({ functionNodeId: functionNode.id, astNode: valueChild! });
        }
      } else if (isModuleLevelDeclarator(node)) {
        const variableNode = createVariableNode(fileNodeId, node);
        if (variableNode) {
          nodes.push(variableNode);
          relationships.push({ from: fileNodeId, to: variableNode.id, type: "DEFINES_VARIABLE", properties: {} });

          // `var app = module.exports = createApp()` is initialized by the call.
          let initializer = valueChild;
          while (initializer?.type === "assignment_expression") initializer = initializer.childForFieldName("right");
          if (initializer?.type === "call_expression" || initializer?.type === "new_expression") {
            const callNode = createInitializerCallNode(fileNodeId, initializer);
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
        appendClassMembers(fileNodeId, classNode, node, nodes, relationships, callbackKeys, functionAstPairs);
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

  return { nodes, relationships, cjsExportBindings, localReExportNames, defaultExportName, defaultExportFrom, functionAstPairs, variableDeclaratorAstNodes };
}

// ─── Language-level finalization ─────────────────────────────────────────────

export function finalizeLanguageLevel(
  fileNodeId: string,
  tree: SyntaxTree,
  state: WalkState,
): ParsedSourceFile {
  const { nodes, relationships, cjsExportBindings, localReExportNames, defaultExportName, defaultExportFrom } = state;

  applyCjsExportBindings(fileNodeId, nodes, relationships, cjsExportBindings);
  relationships.push(...createLocalReExportRelationships(fileNodeId, nodes, relationships, localReExportNames));
  const fileNode = nodes.find((node) => node.id === fileNodeId);
  if (fileNode && defaultExportName) fileNode.properties.defaultExport = defaultExportName;
  if (fileNode && defaultExportFrom) fileNode.properties.defaultExportFrom = defaultExportFrom;

  const moduleLevelCallNodes = createModuleLevelCallNodes(fileNodeId, tree.rootNode);
  nodes.push(...moduleLevelCallNodes);
  relationships.push(...moduleLevelCallNodes.map((c) => ({ from: fileNodeId, to: c.id, type: "MODULE_CALLS" as const, properties: {} })));

  return { fileNodeId, nodes, relationships };
}

// ─── Public helpers ───────────────────────────────────────────────────────────

// The caller owns the tree and must delete() it. `.tsx` files need the TSX
// grammar: the TypeScript one has no JSX and reads `<T>x` as a type assertion.
export function parseTree(source: string, language: SupportedLanguage, filePath = ""): Promise<SyntaxTree> {
  return parseSyntaxTree(grammarFor(language, filePath), source);
}

function grammarFor(language: SupportedLanguage, filePath: string): GrammarName {
  if (language !== "typescript") return "javascript";
  return path.extname(filePath) === ".tsx" ? "tsx" : "typescript";
}

// Node types whose children are statements or class members: a statement with
// a syntax error is left out on its own, and the rest of the file is kept.
const statementParents = new Set(["program", "statement_block", "class_body", "switch_case", "switch_default"]);

// A bare `&` before a letter or `#` in a quoted, space-free JSX attribute value
// (`href="…?family=x&display=swap"`): the JS / TSX grammars only take `&` there
// as the start of an entity such as `&amp;`, and their error recovery can take
// the whole file with it. Valid entities are left alone.
const jsxAttributeValue = /(?<=[\w-]=)(["'])[^"'\s<>{}]*\1/gu;
const bareAmpersand = /&(?!#\d+;|#x[\da-f]+;|[a-z][a-z\d]*;)(?=[a-z#])/giu;

// The same text with those `&` replaced by `_`, for the grammar to read; node
// text still comes from the original, so attribute values are unchanged.
export function withoutBareJsxAmpersands(source: string): string {
  return source.replace(jsxAttributeValue, (value) => value.replace(bareAmpersand, "_"));
}

// Parses a file, leaving out the statements that contain syntax errors. The
// caller owns the tree and must delete() it.
async function parseTolerantTree(
  source: string,
  grammar: GrammarName,
): Promise<{ tree: SyntaxTree; warnings: string[] }> {
  // The stand-in is only used when the file does not parse as written.
  let standIn: ((text: string) => string) | undefined;
  if (withoutBareJsxAmpersands(source) !== source) {
    const plain = await parseSyntaxTree(grammar, source);
    if (!plain.rootNode.hasError) return { tree: plain, warnings: [] };
    plain.delete();
    standIn = withoutBareJsxAmpersands;
  }
  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors(grammar, source, statementParents, undefined, standIn);
  const warnings = skippedLines.length === 0
    ? []
    : [`Syntax error: left out the statement${skippedLines.length === 1 ? "" : "s"} at line${skippedLines.length === 1 ? "" : "s"} ${skippedLines.join(", ")}`];
  return { tree, warnings };
}

// A parsed file as framework plugins see it: the language-level graph plus the
// syntax tree and walk state it was built from. The tree is freed after the
// plugins run, so plugins must not keep nodes from it.
export type JsTsParsedFile = {
  fileNodeId: string;
  rootNode: SyntaxNode;
  parsed: ParsedSourceFile;
  state: WalkState;
  // The inline `<script>` blocks of a markup file, in file order.
  scriptBlocks: readonly ScriptBlock[];
};

// An inline script of a markup file: its code range (source offsets), the
// lines of the element and the attribute names of its start tag.
export type ScriptBlock = { start: number; end: number; line: number; endLine: number; attributes: readonly string[] };

// Framework semantics (routes, entrypoints, ...) hook into the one JS/TS
// parser through plugins; the language layer itself stays framework-agnostic.
// Plugins run in order and add nodes and relationships to `file.parsed`.
export interface JsTsFrameworkPlugin {
  readonly name: string;
  // Object-literal keys whose function values are callbacks the framework
  // calls (`handler`, hooks). Such functions get a Function node of their own.
  readonly callbackPropertyNames?: readonly string[];
  onFile(file: JsTsParsedFile): void;
}

export async function parseJsTsFile(
  rootPath: string,
  filePath: string,
  language: "javascript" | "typescript",
  plugins: readonly JsTsFrameworkPlugin[] = [],
): Promise<ParsedSourceFile> {
  return parseJsTsSource(rootPath, filePath, await readFile(filePath, "utf8"), language, plugins);
}

// Parses `source` as the JS/TS of `filePath`. Files that embed scripts (HTML,
// single-file components) pass their text with everything but the script
// blanked out, so positions point into the original file, and their own
// `fileLanguage` for the File node.
export async function parseJsTsSource(
  rootPath: string,
  filePath: string,
  source: string,
  language: "javascript" | "typescript",
  plugins: readonly JsTsFrameworkPlugin[] = [],
  fileLanguage: SupportedLanguage = language,
  grammar: GrammarName = grammarFor(language, filePath),
  scriptBlocks: readonly ScriptBlock[] = [],
): Promise<ParsedSourceFile> {
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;

  const fileNode: GraphNode = {
    id: fileNodeId,
    label: "File",
    properties: { path: filePath, relativePath, language: fileLanguage },
  };

  const { tree, warnings } = await parseTolerantTree(source, grammar);
  try {
    const callbackKeys = new Set(plugins.flatMap((plugin) => plugin.callbackPropertyNames ?? []));
    const state = walkJsTsNodes(fileNodeId, tree, language, callbackKeys);
    state.nodes.unshift(fileNode);

    const parsed = finalizeLanguageLevel(fileNodeId, tree, state);
    if (warnings.length > 0) parsed.warnings = warnings;
    for (const plugin of plugins) {
      plugin.onFile({ fileNodeId, rootNode: tree.rootNode, parsed, state, scriptBlocks });
    }
    return parsed;
  } finally {
    tree.delete();
  }
}

// Language-level parse (no plugins) that also returns the tree root node for framework
// module boundary tests that need to call applyXxxParseSemantics directly.
export async function parseJsTsWithRootNode(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<{ parsed: ParsedSourceFile; rootNode: SyntaxNode }> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;

  const fileNode: GraphNode = {
    id: fileNodeId,
    label: "File",
    properties: { path: filePath, relativePath, language },
  };

  // The tree stays alive for the caller's root node; this helper is for tests.
  const { tree } = await parseTolerantTree(source, grammarFor(language, filePath));

  const state = walkJsTsNodes(fileNodeId, tree, language);
  state.nodes.unshift(fileNode);

  return { parsed: finalizeLanguageLevel(fileNodeId, tree, state), rootNode: tree.rootNode };
}

function isConditionalRequire(node: SyntaxNode): boolean {
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
