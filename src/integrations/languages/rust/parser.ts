import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTreeSkippingErrors, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import {
  analyzeMemberCallExpression,
  walk,
  walkScoped,
} from "../tree-sitter-utils.js";

// Node types whose children are items, members or statements: one with a
// syntax error is left out on its own, and the rest of the file is kept.
const statementParents = new Set([
  "source_file",
  "declaration_list",
  "block",
  "field_declaration_list",
  "enum_variant_list",
  "ordered_field_declaration_list",
  "match_block",
]);

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

  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors("rust", source, statementParents);
  try {
    const importIds = new Set<string>();
    walk(tree.rootNode, (node) => {
      if (node.type === "use_declaration" || (node.type === "mod_item" && !node.childForFieldName("body"))) {
        for (const importNode of createImportNodes(fileNodeId, node, importIds)) {
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

    const parsed: ParsedSourceFile = { fileNodeId, nodes, relationships };
    if (skippedLines.length > 0) {
      parsed.warnings = [`Syntax error: left out the statement${skippedLines.length === 1 ? "" : "s"} at line${skippedLines.length === 1 ? "" : "s"} ${skippedLines.join(", ")}`];
    }
    return parsed;
  } finally {
    tree.delete();
  }
}

function extractImplTypeName(node: SyntaxNode): string | null {
  if (node.parent?.type !== "declaration_list") return null;
  if (node.parent?.parent?.type !== "impl_item") return null;
  return node.parent.parent.childForFieldName("type")?.text ?? null;
}

type UseEntry = { segments: string[]; alias: string | null; wildcard: boolean };

// One Import per imported path: `use a::{b, c as d, e::*}` is three.
function createImportNodes(fileNodeId: string, node: SyntaxNode, ids: Set<string>): GraphNode[] {
  const line = node.startPosition.row + 1;
  const inlineModules = enclosingInlineModules(node);
  const attribute = pathAttribute(node);
  const base: Record<string, unknown> = {
    specifier: node.text,
    line,
    ...(inlineModules.length > 0 ? { inlineModules: JSON.stringify(inlineModules) } : {}),
  };
  const make = (source: string, extra: Record<string, unknown>): GraphNode => {
    let id = `${fileNodeId}:import:${line}:${source}`;
    for (let n = 2; ids.has(id); n += 1) id = `${fileNodeId}:import:${line}:${source}#${n}`;
    ids.add(id);
    return { id, label: "Import", properties: { source, ...base, ...extra } } as GraphNode;
  };

  if (node.type === "mod_item") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return [];
    return [make(name, { isModule: true, ...(attribute ? { pathAttribute: attribute } : {}) })];
  }

  const argument = node.childForFieldName("argument");
  if (!argument) return [];
  const isPublic = node.namedChildren.some((child) => child.type === "visibility_modifier");
  return flattenUse(argument, []).map((entry) => make(entry.segments.join("::"), {
    ...(isPublic ? { isReExport: true } : {}),
    ...(entry.wildcard ? { isWildcard: true } : {}),
    ...(entry.alias && entry.alias !== "_" ? { alias: entry.alias } : {}),
  }));
}

function flattenUse(node: SyntaxNode, prefix: string[]): UseEntry[] {
  const segmentsOf = (path: SyntaxNode | null): string[] => (path ? path.text.replace(/\s+/gu, "").split("::").filter((part) => part !== "") : []);
  switch (node.type) {
    case "use_list":
      return node.namedChildren.flatMap((child) => flattenUse(child, prefix));
    case "scoped_use_list": {
      const list = node.childForFieldName("list");
      const next = [...prefix, ...segmentsOf(node.childForFieldName("path"))];
      return list ? flattenUse(list, next) : [];
    }
    case "use_as_clause": {
      const target = node.childForFieldName("path");
      return [{ segments: normalizeSelf([...prefix, ...segmentsOf(target)]), alias: node.childForFieldName("alias")?.text ?? null, wildcard: false }];
    }
    case "use_wildcard": {
      const target = node.namedChildren[0] ?? null;
      return [{ segments: [...prefix, ...segmentsOf(target)], alias: null, wildcard: true }];
    }
    case "self":
      return prefix.length > 0 ? [{ segments: prefix, alias: null, wildcard: false }] : [{ segments: ["self"], alias: null, wildcard: false }];
    default:
      return [{ segments: normalizeSelf([...prefix, ...segmentsOf(node)]), alias: null, wildcard: false }];
  }
}

// `a::b::self` names `a::b`.
function normalizeSelf(segments: string[]): string[] {
  return segments.length > 1 && segments[segments.length - 1] === "self" ? segments.slice(0, -1) : segments;
}

function enclosingInlineModules(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "mod_item" && parent.childForFieldName("body")) {
      const name = parent.childForFieldName("name")?.text;
      if (name) names.unshift(name);
    }
  }
  return names;
}

// `#[path = "x.rs"] mod y;`
function pathAttribute(node: SyntaxNode): string | null {
  for (let sibling = node.previousNamedSibling; sibling && (sibling.type === "attribute_item" || sibling.type === "line_comment" || sibling.type === "block_comment"); sibling = sibling.previousNamedSibling) {
    const match = /^#\[\s*path\s*=\s*"([^"]*)"\s*\]$/u.exec(sibling.text.trim());
    if (match) return match[1]!;
  }
  return null;
}

function createFunctionNode(fileNodeId: string, node: SyntaxNode, className?: string): GraphNode | null {
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
      methodKind: null,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      className: className ?? null,
      isExported: rustVisibility(node) !== "private",
      isAsync: node.namedChildren.some((c) => c.type === "function_modifiers" && c.children.some((fc) => fc.type === "async")),
      isAbstract: false,
      visibility: rustVisibility(node),
      parameters: null,
      returnType: null,
    },
  };
}

function createStructNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
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
      isAbstract: false,
      visibility: rustVisibility(node),
    },
  };
}

function rustVisibility(node: SyntaxNode): string {
  const modifier = node.namedChildren.find((c) => c.type === "visibility_modifier")?.text;
  if (!modifier) {
    return "private";
  }

  if (modifier === "pub" || modifier === "pub(crate)" || modifier === "pub(super)") {
    return modifier;
  }

  return modifier.startsWith("pub") ? modifier : "private";
}

function createCallNodes(functionNodeId: string, node: SyntaxNode): GraphNode[] {
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
