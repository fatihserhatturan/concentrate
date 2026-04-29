import path from "node:path";
import type { GraphNode, GraphRelationship } from "../../graph/model.js";

export function createImporterIndex(relationships: GraphRelationship[]): Map<string, string> {
  const importerFileIdByImportId = new Map<string, string>();

  for (const relationship of relationships) {
    if (relationship.type === "IMPORTS") {
      importerFileIdByImportId.set(relationship.to, relationship.from);
    }
  }

  return importerFileIdByImportId;
}

export function createFileIndex(nodes: GraphNode[]): Map<string, string> {
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

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
