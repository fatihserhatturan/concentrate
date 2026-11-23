import type { GraphNode, GraphRelationship, ImportBinding } from "../../../../core/graph/model.js";
import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";

export function addEnvAndConfigRelationships(graph: IGraphContributor): void {
  addRouteEnvRelationships(graph);
  addConfigConsumerRelationships(graph);
}

function addRouteEnvRelationships(graph: IGraphContributor): void {
  const envRelationshipsByFunctionId = new Map<string, GraphRelationship[]>();
  const handledFunctionIdsByRouteId = new Map<string, string[]>();

  for (const rel of graph.relationshipsOfType("USES_ENV")) {
    if (!rel.from.includes(":function:")) continue;
    const list = envRelationshipsByFunctionId.get(rel.from);
    if (list) list.push(rel);
    else envRelationshipsByFunctionId.set(rel.from, [rel]);
  }
  for (const rel of graph.relationshipsOfType("ROUTE_HANDLED_BY")) {
    const list = handledFunctionIdsByRouteId.get(rel.from);
    if (list) list.push(rel.to);
    else handledFunctionIdsByRouteId.set(rel.from, [rel.to]);
  }

  for (const [routeId, functionIds] of handledFunctionIdsByRouteId) {
    // A minimal-API handler with its own range (`handlerStartLine`: a lambda, or a local function) is part of the
    // enclosing Function (often `<top-level>`): copying all of its env reads would put every startup variable on every
    // route. `csharp.config-env` copies the reads inside that range. A method-group handler is a Function of its own and
    // gets all of its reads here (a method group that resolves to `<top-level>` has no handler to read).
    const route = graph.node(routeId);
    const lambda = route?.properties.framework === "aspnet-minimal" && (route.properties.handlerName === "<lambda>" || typeof route.properties.handlerStartLine === "number");
    for (const functionId of functionIds) {
      if (lambda || (route?.properties.framework === "aspnet-minimal" && graph.node(functionId)?.properties.qualifiedName === "<top-level>")) continue;
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

function addConfigConsumerRelationships(graph: IGraphContributor): void {
  const fileIdByImportId = new Map<string, string>();
  const resolvedFileIdByImportId = new Map<string, string>();
  const configValueIdByFileAndName = new Map<string, string>();

  for (const rel of graph.relationshipsOfType("DECLARES_CONFIG")) {
    const name = graph.node(rel.to)?.properties.name;
    if (typeof name === "string") {
      configValueIdByFileAndName.set(key(rel.from, name), rel.to);
    }
  }
  if (configValueIdByFileAndName.size === 0) return;

  for (const rel of graph.relationshipsOfType("IMPORTS")) {
    fileIdByImportId.set(rel.to, rel.from);
  }
  for (const rel of graph.relationshipsOfType("RESOLVES_TO")) {
    resolvedFileIdByImportId.set(rel.from, rel.to);
  }

  for (const [importId, fileId] of fileIdByImportId) {
    const targetFileId = resolvedFileIdByImportId.get(importId);
    if (!targetFileId) continue;

    const importNode = graph.node(importId);
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
