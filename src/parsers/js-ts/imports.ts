import type Parser from "tree-sitter";
import type { GraphNode } from "../../graph/model.js";
import { extractStringSource } from "./common.js";
import {
  extractCjsBindings,
  serializeImportBindings,
} from "./import-bindings.js";

export function createImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
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
      isDynamic: false,
      isCjs: false,
      isTypeOnly: isTypeOnlyImport(node),
      bindings: serializeImportBindings(node),
    },
  };
}

export function createDynamicImportNode(fileNodeId: string, node: Parser.SyntaxNode, source: string): GraphNode {
  return {
    id: `${fileNodeId}:import:${node.startPosition.row + 1}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: node.text,
      line: node.startPosition.row + 1,
      isReExport: false,
      isWildcard: false,
      isDynamic: true,
      isCjs: false,
      isTypeOnly: false,
      bindings: null,
    },
  };
}

export function createCjsImportNode(
  fileNodeId: string,
  node: Parser.SyntaxNode,
  source: string,
  isConditional = false,
): GraphNode {
  return {
    id: `${fileNodeId}:import:${node.startPosition.row + 1}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: node.text,
      line: node.startPosition.row + 1,
      isReExport: false,
      isWildcard: false,
      isDynamic: isConditional,
      isCjs: true,
      isTypeOnly: false,
      bindings: extractCjsBindings(node),
    },
  };
}

export function createReExportImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
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
      isDynamic: false,
      isCjs: false,
      isTypeOnly: isTypeOnlyReExport(node),
      bindings: null,
    },
  };
}

function isTypeOnlyImport(node: Parser.SyntaxNode): boolean {
  return /^import\s+type[\s{]/.test(node.text);
}

function isTypeOnlyReExport(node: Parser.SyntaxNode): boolean {
  return /^export\s+type[\s{]/.test(node.text);
}

function isWildcardReExport(node: Parser.SyntaxNode): boolean {
  return /^export\s+\*/.test(node.text);
}
