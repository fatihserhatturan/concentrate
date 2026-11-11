import type { IGraphContributor } from "../../contracts/graph-contributor.js";
import type { GraphNode } from "../../graph/model.js";
import { createPythonNameLookup } from "./python-names.js";
import type { ResolutionRelationshipIndex } from "./indexes.js";

// Python classes: `class A(B)` is EXTENDS when B is a class of the scan and
// IMPLEMENTS when B is an interface (a Protocol or ABC). A class that has
// every method of a Protocol implements it structurally, if it lives in the
// Protocol's file or in a file that imports it (a Protocol can be satisfied
// by any class, but without that link every class with a `close` method would
// match a `Closeable`).
export function addPythonInheritanceRelationships(
  graph: IGraphContributor,
  index: ResolutionRelationshipIndex,
  classesByFileAndName: Map<string, Map<string, string[]>>,
  interfacesByFileAndName: Map<string, Map<string, string[]>>,
  importsByFile: Map<string, GraphNode[]>,
): void {
  const lookupClass = createPythonNameLookup(classesByFileAndName, importsByFile, index.resolvedFileByImportId);
  const lookupInterface = createPythonNameLookup(interfacesByFileAndName, importsByFile, index.resolvedFileByImportId);
  const declared = new Set<string>();
  const add = (from: string, to: string, type: "EXTENDS" | "IMPLEMENTS") => {
    const key = `${from}\0${to}\0${type}`;
    if (declared.has(key)) return;
    declared.add(key);
    graph.addRelationship({ from, to, type, properties: {} });
  };

  const methodsByClass = new Map<string, Set<string>>();
  const nameById = new Map<string, string>();
  for (const node of graph.nodes) if (node.label === "Function") nameById.set(node.id, String(node.properties.name));
  for (const rel of graph.relationships) {
    if (rel.type !== "DEFINES_METHOD") continue;
    const name = nameById.get(rel.to);
    if (!name) continue;
    const set = methodsByClass.get(rel.from) ?? new Set<string>();
    set.add(name);
    methodsByClass.set(rel.from, set);
  }

  const classes: Array<{ node: GraphNode; fileId: string }> = [];
  for (const node of graph.nodes) {
    if (node.label !== "Class") continue;
    const fileId = index.fileByClassId.get(node.id);
    if (!fileId || !fileId.endsWith(".py")) continue;
    classes.push({ node, fileId });
    for (const base of parseNames(node.properties.extendsNames)) {
      const classId = lookupClass(base, fileId);
      if (classId && classId !== node.id) {
        add(node.id, classId, "EXTENDS");
        continue;
      }
      const interfaceId = lookupInterface(base, fileId);
      if (interfaceId) add(node.id, interfaceId, "IMPLEMENTS");
    }
  }

  // Structural: Protocols.
  const protocolsByFile = new Map<string, Array<{ id: string; methods: string[] }>>();
  for (const node of graph.nodes) {
    if (node.label !== "Interface" || node.properties.kind !== "protocol") continue;
    const fileId = index.fileByInterfaceId.get(node.id);
    const methods = parseNames(node.properties.methods).filter((method) => !(method.startsWith("__") && method.endsWith("__")));
    if (!fileId || methods.length === 0) continue;
    const list = protocolsByFile.get(fileId) ?? [];
    list.push({ id: node.id, methods });
    protocolsByFile.set(fileId, list);
  }
  if (protocolsByFile.size === 0) return;

  for (const { node, fileId } of classes) {
    const own = methodsByClass.get(node.id);
    if (!own) continue;
    const reachable = new Set<string>([fileId]);
    for (const importNode of importsByFile.get(fileId) ?? []) {
      const target = index.resolvedFileByImportId.get(importNode.id);
      if (target) reachable.add(target);
    }
    for (const file of reachable) {
      for (const protocol of protocolsByFile.get(file) ?? []) {
        if (protocol.methods.every((method) => own.has(method))) add(node.id, protocol.id, "IMPLEMENTS");
      }
    }
  }
}

function parseNames(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
