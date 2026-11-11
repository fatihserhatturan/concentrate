import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createRustCallIndex, resolveRustCall, type RustCallIndex } from "../../../core/scan/resolution/rust-calls.js";
import type { RustMount, RustPendingRoute, RustRef } from "./routes.js";

const MAX_MOUNT_DEPTH = 8;

type Mount = { prefix: string | null; layerRefs: Array<{ ref: RustRef; fileId: string }>; layers: string[] };
type Incoming = { mount: RustMount; callerFunctionId: string; fileId: string };

// Finishes the Rust routes once every file is parsed: a route a function
// registers below a router it returns gets the path and layers of each
// mount of that function (`nest("/api", users::routes())`, `.configure(f)`,
// `.service(handler)`, `routes![a, b]`, through any number of functions; one
// Route per distinct mount), and handler and layer references become
// ROUTE_HANDLED_BY and ROUTE_LIFECYCLE_STEP. The extractors of the handler
// (`Path`, `Query`, `Json`, `State`…) are recorded on the route.
export const rustRoutesContributor: ISemanticContributor = {
  contribute(graph) {
    const routes = graph.nodes.filter((node) => node.label === "Route" && typeof node.properties.rustPending === "string");
    const mountOwners = graph.nodes.filter((node) => node.label === "Function" && typeof node.properties.rustMounts === "string");
    if (routes.length === 0 && mountOwners.length === 0) return;

    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const index = createRustCallIndex(graph, relationshipIndex);
    const fileOfFunction = (functionId: string) => relationshipIndex.fileByFunctionId.get(functionId) ?? index.fileByFunctionId.get(functionId) ?? null;

    const incoming = new Map<string, Incoming[]>();
    for (const owner of mountOwners) {
      const mounts = JSON.parse(String(owner.properties.rustMounts)) as RustMount[];
      delete owner.properties.rustMounts;
      const fileId = fileOfFunction(owner.id);
      if (!fileId) continue;
      for (const mount of mounts) {
        for (const target of resolveRef(mount.target, fileId, owner.id, index)) {
          const list = incoming.get(target) ?? [];
          list.push({ mount, callerFunctionId: owner.id, fileId });
          incoming.set(target, list);
        }
      }
    }

    const mountsOf = (functionId: string, depth: number, seen: Set<string>): Mount[] => {
      if (depth > MAX_MOUNT_DEPTH || seen.has(functionId)) return [];
      const result: Mount[] = [];
      for (const { mount, callerFunctionId, fileId } of incoming.get(functionId) ?? []) {
        const own = mount.layerRefs.map((ref) => ({ ref, fileId }));
        const outers = mountsOf(callerFunctionId, depth + 1, new Set([...seen, functionId]));
        if (outers.length === 0) {
          result.push({ prefix: mount.prefix, layerRefs: own, layers: mount.layers });
          continue;
        }
        for (const outer of outers) {
          result.push({
            prefix: outer.prefix === null || mount.prefix === null ? null : joinPaths(outer.prefix, mount.prefix),
            layerRefs: [...outer.layerRefs, ...own],
            layers: [...outer.layers, ...mount.layers],
          });
        }
      }
      return result;
    };

    const fileByRoute = new Map<string, string>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "DECLARES_ROUTE") fileByRoute.set(relationship.to, relationship.from);
    }

    const newNodes: GraphNode[] = [];
    const newRelationships: GraphRelationship[] = [];
    for (const route of routes) {
      const pending = JSON.parse(String(route.properties.rustPending)) as RustPendingRoute;
      delete route.properties.rustPending;
      const fileId = fileByRoute.get(route.id);
      if (!fileId) continue;
      const scopeFunctionId = String(route.properties.scopeFunctionId);
      const path = typeof route.properties.path === "string" ? route.properties.path : null;
      const own = pending.layerRefs.map((ref) => ({ ref, fileId }));
      const handler = pending.attribute ? scopeFunctionId : pending.handler ? resolveRef(pending.handler, fileId, scopeFunctionId, index)[0] ?? null : null;
      if (handler) route.properties.extractors = extractorsOf(graph.nodes, handler);

      const mounts = [...new Map(mountsOf(scopeFunctionId, 0, new Set())
        .map((mount) => [`${mount.prefix}\0${mount.layerRefs.map((step) => step.ref.expression).join("\0")}`, mount])).values()];
      if (mounts.length === 0) {
        route.properties.fullPath = path;
        newRelationships.push(...routeRelationships(route.id, own, handler, scopeFunctionId, index));
        continue;
      }
      mounts.forEach((mount, position) => {
        const node: GraphNode = position === 0 ? route : { ...route, id: `${route.id}@${position}`, properties: { ...route.properties } };
        node.properties.fullPath = mount.prefix === null || path === null ? null : joinPaths(mount.prefix, path);
        const layers = [...mount.layers, ...(typeof route.properties.layers === "string" ? JSON.parse(route.properties.layers) as string[] : [])];
        node.properties.layers = layers.length > 0 ? JSON.stringify(layers) : null;
        if (mount.prefix === null && path !== null) node.properties.pathExpression = "<dynamic mount path>";
        if (position > 0) {
          newNodes.push(node);
          newRelationships.push({ from: fileId, to: node.id, type: "DECLARES_ROUTE", properties: {} });
        }
        newRelationships.push(...routeRelationships(node.id, [...mount.layerRefs, ...own], handler, scopeFunctionId, index));
      });
    }
    graph.addNodes(newNodes);
    graph.addRelationships(newRelationships);
  },
};

function joinPaths(base: string, relative: string): string {
  if (relative === "" || relative === "/") return base === "" ? "/" : base;
  const left = base === "/" ? "" : base.replace(/\/$/u, "");
  return `${left}${relative.startsWith("/") ? relative : `/${relative}`}`;
}

function resolveRef(ref: RustRef, fileId: string, callerFunctionId: string, index: RustCallIndex): string[] {
  const call: GraphNode = { id: `${fileId}:route-ref:${ref.expression}`, label: "Call", properties: { name: ref.expression, expression: ref.expression, callee: ref.callee, receiver: null } };
  return [...new Set(resolveRustCall(call, fileId, callerFunctionId, index).map((target) => target.functionId))];
}

function routeRelationships(
  routeId: string,
  layers: Array<{ ref: RustRef; fileId: string }>,
  handler: string | null,
  scopeFunctionId: string,
  index: RustCallIndex,
): GraphRelationship[] {
  const relationships: GraphRelationship[] = [];
  const steps: Array<{ functionId: string; role: string; hook: string | null; expression: string }> = [];
  for (const layer of layers) {
    const functionId = resolveRef(layer.ref, layer.fileId, scopeFunctionId, index)[0];
    if (functionId) steps.push({ functionId, role: "middleware", hook: null, expression: layer.ref.expression });
  }
  if (handler) {
    relationships.push({ from: routeId, to: handler, type: "ROUTE_HANDLED_BY", properties: {} });
    steps.push({ functionId: handler, role: "handler", hook: "handler", expression: "" });
  }
  steps.forEach((step, orderIndex) => {
    relationships.push({
      from: routeId,
      to: step.functionId,
      type: "ROUTE_LIFECYCLE_STEP",
      properties: { role: step.role, scope: "route", hook: step.hook, orderIndex, ...step.expression ? { expression: step.expression } : {} },
    });
  });
  for (let orderIndex = 0; orderIndex < steps.length - 1; orderIndex += 1) {
    relationships.push({
      from: steps[orderIndex]!.functionId,
      to: steps[orderIndex + 1]!.functionId,
      type: "LIFECYCLE_PRECEDES",
      properties: { routeId, scope: "route", orderIndex },
    });
  }
  return relationships;
}

const extractorKinds = new Map([
  ["Path", "path"], ["Query", "query"], ["Json", "json"], ["State", "state"], ["Form", "form"], ["Data", "state"],
  ["Extension", "extension"], ["TypedHeader", "header"], ["HeaderMap", "header"], ["Multipart", "multipart"],
  ["Bytes", "body"], ["Payload", "body"], ["CookieJar", "cookies"], ["Cookies", "cookies"], ["Host", "header"],
  ["ConnectInfo", "connection"], ["Request", "request"], ["HttpRequest", "request"], ["Session", "session"], ["Lenient", "query"],
]);

// The parameters of the handler that axum, actix-web and Rocket fill from the
// request, as `[{kind, type}]`.
function extractorsOf(nodes: readonly GraphNode[], functionId: string): string | null {
  const fn = nodes.find((node) => node.id === functionId);
  if (typeof fn?.properties.parameters !== "string") return null;
  const found: Array<{ kind: string; type: string }> = [];
  for (const parameter of JSON.parse(fn.properties.parameters) as Array<{ name: string | null; type: string | null }>) {
    if (!parameter.type || parameter.name === "self") continue;
    const type = parameter.type.replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/u, "").replace(/\s+/gu, "");
    const base = /^(?:[\w]+::)*(\w+)/u.exec(type)?.[1];
    const kind = base ? extractorKinds.get(base) : undefined;
    if (kind) found.push({ kind, type });
  }
  return found.length > 0 ? JSON.stringify(found) : null;
}
