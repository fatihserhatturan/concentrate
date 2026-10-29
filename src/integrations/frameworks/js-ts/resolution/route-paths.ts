import type { GraphNode, GraphRelationship, ImportBinding } from "../../../../core/graph/model.js";
import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";

type RoutePathContext = {
  fileIdByRouteId: Map<string, string>;
  variableIdByFileAndName: Map<string, string>;
  fileIdByVariableId: Map<string, string>;
  constantsByFileId: Map<string, Map<string, string>>;
  incomingMountsByTargetId: Map<string, GraphRelationship[]>;
};

export function resolveRouteFullPaths(graph: IGraphContributor): void {
  resolveImportedMountTargets(graph);
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
    // A route declared in a function (a Fastify plugin) takes the prefixes of
    // the mounts of that function: `fastify.register(plugin, { prefix })`.
    const scopeFunctionId = route.properties.scopeFunctionId;
    const receiverId = typeof scopeFunctionId === "string"
      ? scopeFunctionId
      : typeof receiverName === "string"
        ? context.variableIdByFileAndName.get(key(fileId, receiverName))
        : undefined;
    const prefixes = receiverId ? resolveMountPrefixes(receiverId, context, new Set()) : [""];
    route.properties.fullPath = chooseBestFullPath(prefixes, rawPath);
  }

  applyNestGlobalPrefixes(graph, context);
}

// A mount of a router imported from another file (`app.use(routes)` with
// `import routes from './routes'`, `app.use('/v1', require('./v1'))`) points
// at the Import after the parse. It is moved to the router that file exports:
// the variable its default export names (`export default router`,
// `module.exports = router`) or the default export expression itself
// (`export default Router().use(...)`), or the named export's variable. A
// mount whose router is not found is dropped.
function resolveImportedMountTargets(graph: IGraphContributor): void {
  const mounts = graph.relationships.filter((rel) => rel.type === "MOUNTS" && typeof rel.properties.importedName === "string");
  if (mounts.length === 0) return;

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const resolvedFileByImportId = new Map<string, string>();
  const variableIdByFileAndName = new Map<string, string>();
  for (const rel of graph.relationships) {
    if (rel.type === "RESOLVES_TO") {
      resolvedFileByImportId.set(rel.from, rel.to);
    } else if (rel.type === "DEFINES_VARIABLE") {
      const name = nodeById.get(rel.to)?.properties.name;
      if (typeof name === "string") variableIdByFileAndName.set(key(rel.from, name), rel.to);
    }
  }

  const unresolved = new Set<GraphRelationship>();
  for (const mount of mounts) {
    const importedName = mount.properties.importedName as string;
    delete mount.properties.importedName;

    const fileId = resolvedFileByImportId.get(mount.to);
    const defaultName = fileId ? nodeById.get(fileId)?.properties.defaultExport : undefined;
    const targetId = !fileId
      ? undefined
      : importedName === "default"
        ? (typeof defaultName === "string" ? variableIdByFileAndName.get(key(fileId, defaultName)) : undefined)
          ?? variableIdByFileAndName.get(key(fileId, "default"))
        : variableIdByFileAndName.get(key(fileId, importedName));
    if (targetId) mount.to = targetId;
    else unresolved.add(mount);
  }

  if (unresolved.size === 0) return;
  for (let index = graph.relationships.length - 1; index >= 0; index -= 1) {
    if (unresolved.has(graph.relationships[index]!)) graph.relationships.splice(index, 1);
  }
}

// app.setGlobalPrefix('api') prefixes every NestJS route of the application.
// The prefix applies to the routes of the package that calls it (the whole
// repo when there are no packages); a package with conflicting prefixes is left
// alone. The `exclude` option is not modelled.
function applyNestGlobalPrefixes(graph: IGraphContributor, context: RoutePathContext): void {
  const packageIdByFileId = new Map<string, string>();
  for (const rel of graph.relationships) {
    if (rel.type === "PACKAGE_CONTAINS_FILE") packageIdByFileId.set(rel.to, rel.from);
  }
  const fileIds = new Set(context.fileIdByRouteId.values());
  for (const node of graph.nodes) {
    if (node.label === "File") fileIds.add(node.id);
  }

  const prefixesByScope = new Map<string, Set<string>>();
  for (const call of graph.nodes) {
    if (call.label !== "Call" || call.properties.callee !== "setGlobalPrefix" || !call.properties.receiver) continue;

    const fileId = owningFileId(call.id, fileIds);
    const argument = fileId ? firstCallArg(call) : null;
    if (!fileId || argument === null) continue;

    const prefix = context.constantsByFileId.get(fileId)?.get(argument) ?? argument;
    const scope = packageIdByFileId.get(fileId) ?? "";
    prefixesByScope.set(scope, (prefixesByScope.get(scope) ?? new Set()).add(prefix));
  }

  for (const route of graph.nodes) {
    if (route.label !== "Route" || route.properties.framework !== "nestjs") continue;

    const fileId = context.fileIdByRouteId.get(route.id);
    const fullPath = route.properties.fullPath;
    if (!fileId || typeof fullPath !== "string") continue;

    const prefixes = prefixesByScope.get(packageIdByFileId.get(fileId) ?? "");
    if (prefixes?.size !== 1) continue;
    route.properties.fullPath = joinRoutePaths([...prefixes][0]!, fullPath);
  }
}

function owningFileId(nodeId: string, fileIds: Set<string>): string | null {
  for (let end = nodeId.indexOf(":", "file:".length); end !== -1; end = nodeId.indexOf(":", end + 1)) {
    const candidate = nodeId.slice(0, end);
    if (fileIds.has(candidate)) return candidate;
  }
  return null;
}

function firstCallArg(call: GraphNode): string | null {
  const args = call.properties.args;
  if (typeof args !== "string") return null;

  try {
    const parsed = JSON.parse(args) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null;
  } catch {
    return null;
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
