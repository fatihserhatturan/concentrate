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
      bindings: null,
    },
  };
}

export function createCjsImportNode(fileNodeId: string, node: Parser.SyntaxNode, source: string): GraphNode {
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
      isCjs: true,
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
      bindings: null,
    },
  };
}

function isWildcardReExport(node: Parser.SyntaxNode): boolean {
  return /^export\s+\*/.test(node.text);
}
