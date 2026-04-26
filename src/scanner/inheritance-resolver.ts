import { GraphBuilder } from "../graph/builder.js";
import type { GraphNode } from "../graph/model.js";

export function addInheritanceRelationships(graph: GraphBuilder): void {
  const fileByClassId = new Map<string, string>();
  const fileByInterfaceId = new Map<string, string>();
  const fileByImportId = new Map<string, string>();
  const resolvedFileByImportId = new Map<string, string>();

  for (const rel of graph.relationships) {
    switch (rel.type) {
      case "DEFINES_CLASS":
        fileByClassId.set(rel.to, rel.from);
        break;
      case "DEFINES_INTERFACE":
        fileByInterfaceId.set(rel.to, rel.from);
        break;
      case "IMPORTS":
        fileByImportId.set(rel.to, rel.from);
        break;
      case "RESOLVES_TO":
        resolvedFileByImportId.set(rel.from, rel.to);
        break;
    }
  }

  const classesByFileAndName = indexNodesByFileAndName(graph.nodes, fileByClassId, "Class");
  const interfacesByFileAndName = indexNodesByFileAndName(graph.nodes, fileByInterfaceId, "Interface");
  const importsByFile = indexImportsByFile(graph.nodes, fileByImportId);

  for (const node of graph.nodes) {
    if (node.label !== "Class") continue;

    const fileId = fileByClassId.get(node.id);
    if (!fileId) continue;

    for (const extendsName of parseNameList(node.properties.extendsNames)) {
      const targetClassId = resolveNamedNode(
        extendsName,
        fileId,
        classesByFileAndName,
        importsByFile,
        resolvedFileByImportId,
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
        resolvedFileByImportId,
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

function indexNodesByFileAndName(
  nodes: GraphNode[],
  fileByNodeId: Map<string, string>,
  label: "Class" | "Interface",
): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();

  for (const node of nodes) {
    if (node.label !== label) continue;
    const fileId = fileByNodeId.get(node.id);
    if (!fileId) continue;
    const name = node.properties.name;
    if (typeof name !== "string") continue;

    let byName = result.get(fileId);
    if (!byName) {
      byName = new Map();
      result.set(fileId, byName);
    }
    byName.set(name, node.id);
  }

  return result;
}

function indexImportsByFile(
  nodes: GraphNode[],
  fileByImportId: Map<string, string>,
): Map<string, GraphNode[]> {
  const result = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    if (node.label !== "Import") continue;
    const fileId = fileByImportId.get(node.id);
    if (!fileId) continue;
    const list = result.get(fileId) ?? [];
    list.push(node);
    result.set(fileId, list);
  }

  return result;
}

function resolveNamedNode(
  rawName: string,
  fileId: string,
  nodesByFileAndName: Map<string, Map<string, string>>,
  importsByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  const name = lastNameSegment(rawName);
  const sameFile = nodesByFileAndName.get(fileId)?.get(name);
  if (sameFile) return sameFile;

  for (const importNode of importsByFile.get(fileId) ?? []) {
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;
    const imported = nodesByFileAndName.get(targetFileId)?.get(name);
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
