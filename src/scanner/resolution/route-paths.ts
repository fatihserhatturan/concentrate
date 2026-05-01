import type { GraphNode, GraphRelationship, ImportBinding } from "../../graph/model.js";
import { GraphBuilder } from "../../graph/builder.js";

type RoutePathContext = {
  fileIdByRouteId: Map<string, string>;
  variableIdByFileAndName: Map<string, string>;
  fileIdByVariableId: Map<string, string>;
  constantsByFileId: Map<string, Map<string, string>>;
  incomingMountsByTargetId: Map<string, GraphRelationship[]>;
};

export function resolveRouteFullPaths(graph: GraphBuilder): void {
  const context = createRoutePathContext(graph.nodes, graph.relationships);

  resolveImportedStringConstants(graph.nodes, graph.relationships, context.constantsByFileId);
  resolveMountPathExpressions(graph.relationships, context);

  for (const route of graph.nodes) {
    if (route.label !== "Route") continue;

    const fileId = context.fileIdByRouteId.get(route.id);
    if (!fileId) continue;

    const rawPath = resolveRoutePath(route, fileId, context.constantsByFileId);
    route.properties.path = rawPath;

    const receiverName = route.properties.receiverName;
    const receiverId = typeof receiverName === "string"
      ? context.variableIdByFileAndName.get(key(fileId, receiverName))
      : undefined;
    const prefixes = receiverId ? resolveMountPrefixes(receiverId, context, new Set()) : [""];
    route.properties.fullPath = chooseBestFullPath(prefixes, rawPath);
  }
}

function createRoutePathContext(nodes: GraphNode[], relationships: GraphRelationship[]): RoutePathContext {
  const fileIdByRouteId = new Map<string, string>();
  const variableIdByFileAndName = new Map<string, string>();
  const fileIdByVariableId = new Map<string, string>();
  const constantsByFileId = new Map<string, Map<string, string>>();
  const incomingMountsByTargetId = new Map<string, GraphRelationship[]>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const rel of relationships) {
    if (rel.type === "DECLARES_ROUTE") {
      fileIdByRouteId.set(rel.to, rel.from);
      continue;
    }

    if (rel.type === "DEFINES_VARIABLE") {
      const variable = nodeById.get(rel.to);
      if (variable?.label !== "Variable") continue;
      const name = variable.properties.name;
      if (typeof name !== "string") continue;

      variableIdByFileAndName.set(key(rel.from, name), variable.id);
      fileIdByVariableId.set(variable.id, rel.from);

      const stringValue = variable.properties.stringValue;
      if (typeof stringValue === "string") {
        setFileConstant(constantsByFileId, rel.from, name, stringValue);
      }
      continue;
    }

    if (rel.type === "MOUNTS") {
      incomingMountsByTargetId.set(rel.to, [
        ...(incomingMountsByTargetId.get(rel.to) ?? []),
        rel,
      ]);
    }
  }

  return {
    fileIdByRouteId,
    variableIdByFileAndName,
    fileIdByVariableId,
    constantsByFileId,
    incomingMountsByTargetId,
  };
}

function resolveImportedStringConstants(
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  constantsByFileId: Map<string, Map<string, string>>,
): void {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const importFileIdByImportId = new Map<string, string>();
  const resolvedFileIdByImportId = new Map<string, string>();

  for (const rel of relationships) {
    if (rel.type === "IMPORTS") {
      importFileIdByImportId.set(rel.to, rel.from);
    } else if (rel.type === "RESOLVES_TO") {
      resolvedFileIdByImportId.set(rel.from, rel.to);
    }
  }

  for (const [importId, importerFileId] of importFileIdByImportId) {
    const targetFileId = resolvedFileIdByImportId.get(importId);
    if (!targetFileId) continue;

    const importNode = nodeById.get(importId);
    if (importNode?.label !== "Import") continue;

    const bindings = parseImportBindings(importNode.properties.bindings);
    for (const binding of bindings) {
      if (binding.kind !== "named") continue;

      const importedValue = constantsByFileId.get(targetFileId)?.get(binding.imported);
      if (typeof importedValue === "string") {
        setFileConstant(constantsByFileId, importerFileId, binding.local, importedValue);
      }
    }
  }
}

function resolveMountPathExpressions(relationships: GraphRelationship[], context: RoutePathContext): void {
  for (const rel of relationships) {
    if (rel.type !== "MOUNTS") continue;
    if (typeof rel.properties.path === "string") continue;

    const expression = rel.properties.pathExpression;
    const sourceFileId = context.fileIdByVariableId.get(rel.from);
    if (typeof expression !== "string" || !sourceFileId) continue;

    rel.properties.path = context.constantsByFileId.get(sourceFileId)?.get(expression) ?? null;
  }
}

function resolveRoutePath(
  route: GraphNode,
  fileId: string,
  constantsByFileId: Map<string, Map<string, string>>,
): string | null {
  const rawPath = route.properties.path;
  if (typeof rawPath === "string") return rawPath;

  const expression = route.properties.pathExpression;
  if (typeof expression !== "string") return null;

  return constantsByFileId.get(fileId)?.get(expression) ?? null;
}

function resolveMountPrefixes(
  receiverId: string,
  context: RoutePathContext,
  visited: Set<string>,
): string[] {
  if (visited.has(receiverId)) return [""];
  visited.add(receiverId);

  const incomingMounts = context.incomingMountsByTargetId.get(receiverId) ?? [];
  if (incomingMounts.length === 0) return [""];

  const prefixes: string[] = [];
  for (const mount of incomingMounts) {
    const mountPath = typeof mount.properties.path === "string" ? mount.properties.path : "";
    for (const parentPrefix of resolveMountPrefixes(mount.from, context, new Set(visited))) {
      prefixes.push(joinRoutePaths(parentPrefix, mountPath));
    }
  }

  return prefixes.length > 0 ? prefixes : [""];
}

function chooseBestFullPath(prefixes: string[], rawPath: string | null): string | null {
  if (rawPath === null) return null;
  const prefix = prefixes.find((value) => value !== "") ?? prefixes[0] ?? "";
  return joinRoutePaths(prefix, rawPath);
}

function joinRoutePaths(basePath: string | null, routePath: string | null): string {
  const cleanBase = trimSlashes(basePath);
  const cleanRoute = trimSlashes(routePath);
  const joined = [cleanBase, cleanRoute].filter(Boolean).join("/");
  return joined ? `/${joined}` : "/";
}

function trimSlashes(value: string | null): string {
  return value?.replace(/^\/+|\/+$/g, "") ?? "";
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

function setFileConstant(
  constantsByFileId: Map<string, Map<string, string>>,
  fileId: string,
  name: string,
  value: string,
): void {
  constantsByFileId.set(fileId, constantsByFileId.get(fileId) ?? new Map());
  constantsByFileId.get(fileId)!.set(name, value);
}

function key(fileId: string, name: string): string {
  return `${fileId}:${name}`;
}
