import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import type { GraphNode, GraphRelationship } from "../graph/model.js";

const importTargetExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
const jsRuntimeExtensions = [".js", ".jsx", ".mjs", ".cjs"];

export function addImportResolutionRelationships(graph: GraphBuilder): {
  resolved: number;
  unresolved: number;
} {
  const fileIdByRelativePath = createFileIndex(graph.nodes);
  const importerFileIdByImportId = createImporterIndex(graph.relationships);
  let resolved = 0;
  let unresolved = 0;

  for (const node of graph.nodes) {
    if (node.label !== "Import") {
      continue;
    }

    const source = node.properties.source;
    if (typeof source !== "string" || !source.startsWith(".")) {
      continue;
    }

    const importerFileId = importerFileIdByImportId.get(node.id);
    const targetFileId = importerFileId
      ? resolveRelativeImport(source, importerFileId, fileIdByRelativePath)
      : null;

    if (!targetFileId) {
      unresolved += 1;
      continue;
    }

    graph.addRelationship({
      from: node.id,
      to: targetFileId,
      type: "RESOLVES_TO",
      properties: {},
    });
    resolved += 1;
  }

  return { resolved, unresolved };
}

function createImporterIndex(relationships: GraphRelationship[]): Map<string, string> {
  const importerFileIdByImportId = new Map<string, string>();

  for (const relationship of relationships) {
    if (relationship.type === "IMPORTS") {
      importerFileIdByImportId.set(relationship.to, relationship.from);
    }
  }

  return importerFileIdByImportId;
}

function createFileIndex(nodes: GraphNode[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const node of nodes) {
    if (node.label !== "File") {
      continue;
    }

    const relativePath = node.properties.relativePath;
    if (typeof relativePath === "string") {
      index.set(toPosixPath(relativePath), node.id);
    }
  }

  return index;
}

function resolveRelativeImport(
  source: string,
  importerFileId: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const importerRelativePath = importerFileId.slice("file:".length);
  const importerDirectory = path.posix.dirname(toPosixPath(importerRelativePath));
  const importBasePath = path.posix.normalize(path.posix.join(importerDirectory, source));

  for (const candidate of createImportCandidates(importBasePath)) {
    const targetFileId = fileIdByRelativePath.get(candidate);
    if (targetFileId) {
      return targetFileId;
    }
  }

  return null;
}

function createImportCandidates(importBasePath: string): string[] {
  const candidates = new Set<string>();
  const extension = path.posix.extname(importBasePath);

  candidates.add(importBasePath);

  if (extension) {
    const withoutExtension = importBasePath.slice(0, -extension.length);
    if (jsRuntimeExtensions.includes(extension)) {
      for (const candidateExtension of importTargetExtensions) {
        candidates.add(`${withoutExtension}${candidateExtension}`);
      }
    }
  } else {
    for (const candidateExtension of importTargetExtensions) {
      candidates.add(`${importBasePath}${candidateExtension}`);
    }
  }

  for (const candidateExtension of importTargetExtensions) {
    candidates.add(path.posix.join(importBasePath, `index${candidateExtension}`));
  }

  return [...candidates];
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
