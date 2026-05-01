import type { GraphNode, GraphRelationship, ImportBinding } from "../../graph/model.js";
import { GraphBuilder } from "../../graph/builder.js";

export function addEnvAndConfigRelationships(graph: GraphBuilder): void {
  addRouteEnvRelationships(graph);
  addConfigConsumerRelationships(graph);
}

function addRouteEnvRelationships(graph: GraphBuilder): void {
  const envRelationshipsByFunctionId = new Map<string, GraphRelationship[]>();
  const handledFunctionIdsByRouteId = new Map<string, string[]>();

  for (const rel of graph.relationships) {
    if (rel.type === "USES_ENV" && rel.from.includes(":function:")) {
      envRelationshipsByFunctionId.set(rel.from, [
        ...(envRelationshipsByFunctionId.get(rel.from) ?? []),
        rel,
      ]);
    } else if (rel.type === "ROUTE_HANDLED_BY") {
      handledFunctionIdsByRouteId.set(rel.from, [
        ...(handledFunctionIdsByRouteId.get(rel.from) ?? []),
        rel.to,
      ]);
    }
  }

  for (const [routeId, functionIds] of handledFunctionIdsByRouteId) {
    for (const functionId of functionIds) {
      for (const envRel of envRelationshipsByFunctionId.get(functionId) ?? []) {
        graph.addRelationship({
          from: routeId,
          to: envRel.to,
          type: "USES_ENV",
          properties: {
            line: envRel.properties.line,
            access: envRel.properties.access,
          },
        });
      }
    }
  }
}

function addConfigConsumerRelationships(graph: GraphBuilder): void {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileIdByImportId = new Map<string, string>();
  const resolvedFileIdByImportId = new Map<string, string>();
  const configValueIdByFileAndName = new Map<string, string>();

  for (const rel of graph.relationships) {
    if (rel.type === "IMPORTS") {
      fileIdByImportId.set(rel.to, rel.from);
    } else if (rel.type === "RESOLVES_TO") {
      resolvedFileIdByImportId.set(rel.from, rel.to);
    } else if (rel.type === "DECLARES_CONFIG") {
      const configNode = nodeById.get(rel.to);
      const name = configNode?.properties.name;
      if (typeof name === "string") {
        configValueIdByFileAndName.set(key(rel.from, name), rel.to);
      }
    }
  }

  for (const [importId, fileId] of fileIdByImportId) {
    const targetFileId = resolvedFileIdByImportId.get(importId);
    if (!targetFileId) continue;

    const importNode = nodeById.get(importId);
    if (importNode?.label !== "Import") continue;

    for (const binding of parseImportBindings(importNode.properties.bindings)) {
      if (binding.kind !== "named") continue;

      const configValueId = configValueIdByFileAndName.get(key(targetFileId, binding.imported));
      if (!configValueId) continue;

      graph.addRelationship({
        from: fileId,
        to: configValueId,
        type: "CONSUMES_CONFIG",
        properties: {
          localName: binding.local,
        },
      });
    }
  }
}

function parseImportBindings(value: unknown): ImportBinding[] {
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isImportBinding);
  } catch {
    return [];
  }
}

function isImportBinding(value: unknown): value is ImportBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.imported === "string"
    && typeof binding.local === "string"
    && (binding.kind === "named" || binding.kind === "default" || binding.kind === "namespace");
}

function key(fileId: string, name: string): string {
  return `${fileId}:${name}`;
}
