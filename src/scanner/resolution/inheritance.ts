import { GraphBuilder } from "../../graph/builder.js";
import type { GraphNode } from "../../graph/model.js";
import {
  createResolutionRelationshipIndex,
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "./indexes.js";

export function addInheritanceRelationships(graph: GraphBuilder): void {
  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const classesByFileAndName = indexNodesByFileAndName(graph.nodes, relationshipIndex.fileByClassId, "Class");
  const interfacesByFileAndName = indexNodesByFileAndName(graph.nodes, relationshipIndex.fileByInterfaceId, "Interface");
  const importsByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);

  for (const node of graph.nodes) {
    if (node.label !== "Class") continue;

    const fileId = relationshipIndex.fileByClassId.get(node.id);
    if (!fileId) continue;

    for (const extendsName of parseNameList(node.properties.extendsNames)) {
      const targetClassId = resolveNamedNode(
        extendsName,
        fileId,
        classesByFileAndName,
        importsByFile,
        relationshipIndex.resolvedFileByImportId,
      );
      if (!targetClassId || targetClassId === node.id) continue;

      graph.addRelationship({
        from: node.id,
        to: targetClassId,
        type: "EXTENDS",
        properties: {},
      });
    }

    for (const implementsName of parseNameList(node.properties.implementsNames)) {
      const targetInterfaceId = resolveNamedNode(
        implementsName,
        fileId,
        interfacesByFileAndName,
        importsByFile,
        relationshipIndex.resolvedFileByImportId,
      );
      if (!targetInterfaceId) continue;

      graph.addRelationship({
        from: node.id,
        to: targetInterfaceId,
        type: "IMPLEMENTS",
        properties: {},
      });
    }
  }
}

function resolveNamedNode(
  rawName: string,
  fileId: string,
  nodesByFileAndName: Map<string, Map<string, string[]>>,
  importsByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  const name = lastNameSegment(rawName);
  const sameFile = nodesByFileAndName.get(fileId)?.get(name)?.[0];
  if (sameFile) return sameFile;

  for (const importNode of importsByFile.get(fileId) ?? []) {
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;
    const imported = nodesByFileAndName.get(targetFileId)?.get(name)?.[0];
    if (imported) return imported;
  }

  return null;
}

function parseNameList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function lastNameSegment(name: string): string {
  return name.split(".").at(-1) ?? name;
}
