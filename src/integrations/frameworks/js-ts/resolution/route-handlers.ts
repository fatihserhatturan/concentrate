import type { GraphRelationship, ImportBinding } from "../../../../core/graph/model.js";
import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import { createLifecycleRelationships, type PendingHandlerRefs } from "../route-graph.js";

// Links route handlers and middleware that a route file imports by name
// (`import { listUsers } from './users'`, `const { auth } = require('./auth')`)
// to their Function nodes. The parse-time route graph sees one file only and
// records what it could not resolve in Route.pendingHandlerRefs.
export function addImportedRouteHandlerRelationships(graph: IGraphContributor): void {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileIdByRouteId = new Map<string, string>();
  const functionIdsByFile = new Map<string, Map<string, string>>();
  const importIdsByFile = new Map<string, string[]>();
  const resolvedFileByImportId = new Map<string, string>();

  for (const rel of graph.relationships) {
    if (rel.type === "DECLARES_ROUTE") {
      fileIdByRouteId.set(rel.to, rel.from);
    } else if (rel.type === "DEFINES_FUNCTION") {
      const name = nodeById.get(rel.to)?.properties.name;
      if (typeof name !== "string") continue;
      const functions = functionIdsByFile.get(rel.from) ?? new Map<string, string>();
      if (!functions.has(name)) functions.set(name, rel.to);
      functionIdsByFile.set(rel.from, functions);
    } else if (rel.type === "IMPORTS") {
      importIdsByFile.set(rel.from, [...(importIdsByFile.get(rel.from) ?? []), rel.to]);
    } else if (rel.type === "RESOLVES_TO") {
      resolvedFileByImportId.set(rel.from, rel.to);
    }
  }

  const resolveName = (fileId: string, name: string): string | null => {
    const local = functionIdsByFile.get(fileId)?.get(name);
    if (local) return local;

    for (const importId of importIdsByFile.get(fileId) ?? []) {
      const targetFileId = resolvedFileByImportId.get(importId);
      const importNode = nodeById.get(importId);
      if (!targetFileId || importNode?.label !== "Import") continue;

      const binding = parseImportBindings(importNode.properties.bindings)
        .find((b) => b.kind === "named" && b.local === name);
      if (!binding) continue;

      const found = functionIdsByFile.get(targetFileId)?.get(binding.imported);
      if (found) return found;
    }

    return null;
  };

  const added: GraphRelationship[] = [];
  for (const node of graph.nodes) {
    if (node.label !== "Route") continue;

    const pending = parsePendingHandlerRefs(node.properties.pendingHandlerRefs);
    const fileId = fileIdByRouteId.get(node.id);
    if (!pending || !fileId) continue;

    for (const name of pending.handlers) {
      const functionId = resolveName(fileId, name);
      if (!functionId) continue;
      added.push({ from: node.id, to: functionId, type: "ROUTE_HANDLED_BY", properties: {} });
    }

    const functionIdsByName = new Map<string, string>();
    for (const step of pending.steps) {
      const functionId = pending.local?.[step.name] ?? resolveName(fileId, step.name);
      if (functionId) functionIdsByName.set(step.name, functionId);
    }
    added.push(...createLifecycleRelationships(node.id, pending.steps, functionIdsByName));
  }

  graph.addRelationships(added);
}

function parsePendingHandlerRefs(value: unknown): PendingHandlerRefs | null {
  if (typeof value !== "string") return null;

  try {
    const parsed = JSON.parse(value) as Partial<PendingHandlerRefs>;
    return {
      handlers: Array.isArray(parsed.handlers) ? parsed.handlers : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      ...(parsed.local && typeof parsed.local === "object" ? { local: parsed.local } : {}),
    };
  } catch {
    return null;
  }
}

function parseImportBindings(value: unknown): ImportBinding[] {
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as ImportBinding[] : [];
  } catch {
    return [];
  }
}
