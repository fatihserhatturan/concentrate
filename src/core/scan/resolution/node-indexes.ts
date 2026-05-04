import type { GraphNode } from "../../graph/model.js";

export function indexNodesByFileAndName(
  nodes: GraphNode[],
  fileByNodeId: Map<string, string>,
  label: "Class" | "Function" | "Interface",
): Map<string, Map<string, string[]>> {
  const result = new Map<string, Map<string, string[]>>();

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
    const list = byName.get(name) ?? [];
    list.push(node.id);
    byName.set(name, list);
  }

  return result;
}

export function indexImportNodesByFile(
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
