import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createGoCallIndex, resolveGoCall, type GoCallIndex } from "../../../core/scan/resolution/go-calls.js";
import { joinRoutePaths, RETURNED_ROUTER, type GoHandlerRef, type GoPendingRoute, type GoRouterArgument } from "./routes.js";

// How deep a router is followed through functions that pass it on.
const MAX_MOUNT_DEPTH = 8;

type Mount = { prefix: string | null; middleware: Array<{ ref: GoHandlerRef; fileId: string }> };

type CallerArgument = { argument: GoRouterArgument; callerFunctionId: string; fileId: string };

// Finishes the Go routes once every file is parsed: a route registered on a
// router parameter gets the path and middleware of each call that passes a
// router in (`users.UsersRegister(v1.Group("/users"))`, through any number
// of functions; one Route per distinct mount; a router a function returns
// gets the path its callers mount the result at), and handler and middleware
// references become ROUTE_HANDLED_BY and ROUTE_LIFECYCLE_STEP.
export const goRoutesContributor: ISemanticContributor = {
  contribute(graph) {
    const routes = graph.nodes.filter((node) => node.label === "Route" && typeof node.properties.goPending === "string");
    const routerCalls = graph.nodes.filter((node) => node.label === "Call" && typeof node.properties.routerArguments === "string");
    if (routes.length === 0 && routerCalls.length === 0) return;

    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const goIndex = createGoCallIndex(graph, relationshipIndex);
    const fileOfFunction = (functionId: string) => relationshipIndex.fileByFunctionId.get(functionId) ?? goIndex.fileByFunctionId.get(functionId) ?? null;

    const targetsByCall = new Map<string, string[]>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "CALL_RESOLVES_TO") targetsByCall.set(relationship.from, [...targetsByCall.get(relationship.from) ?? [], relationship.to]);
    }
    const argumentsByFunction = new Map<string, CallerArgument[]>();
    // Functions that return a router: their routes, or a router they pass on
    // or mount, come from the result.
    const returning = new Set<string>();
    for (const route of routes) {
      if ((JSON.parse(String(route.properties.goPending)) as GoPendingRoute).base === RETURNED_ROUTER) returning.add(String(route.properties.scopeFunctionId));
    }
    const fallbacks: Array<{ call: GraphNode; argument: GoRouterArgument; fileId: string }> = [];
    for (const call of routerCalls) {
      const callerFunctionId = relationshipIndex.callerFunctionByCallId.get(call.id);
      const fileId = callerFunctionId ? fileOfFunction(callerFunctionId) : null;
      const routerArguments = JSON.parse(String(call.properties.routerArguments)) as GoRouterArgument[];
      delete call.properties.routerArguments;
      if (!callerFunctionId || !fileId) continue;
      for (const argument of routerArguments) {
        if (argument.base === RETURNED_ROUTER) returning.add(callerFunctionId);
        if (argument.fallback) fallbacks.push({ call, argument, fileId });
        // `r.Route("/admin", adminRoutes)`: adminRoutes gets the router as
        // its first parameter.
        const targets = argument.callback
          ? [resolveRef(argument.callback, fileId, goIndex)].filter((target): target is string => target !== null)
          : targetsByCall.get(call.id) ?? [];
        for (const target of targets) {
          argumentsByFunction.set(target, [...argumentsByFunction.get(target) ?? [], { argument, callerFunctionId, fileId }]);
        }
      }
    }

    // A test that mounts a production router (`UsersRegister(r.Group("/users"))`
    // in a _test.go file) does not give the production routes another path.
    const testFiles = new Set(graph.nodes.filter((node) => node.label === "File" && node.properties.isTest === true).map((node) => node.id));
    // A mount of what a call returns (`mux.Handle("/x", withAuth(h))`) is a
    // route of its own unless the function called returns a router.
    for (const { call, argument, fileId } of fallbacks) {
      if ((targetsByCall.get(call.id) ?? []).some((target) => returning.has(target))) continue;
      for (const fallback of argument.fallback ?? []) {
        const node: GraphNode = { id: fallback.id, label: "Route", properties: { ...fallback.properties } };
        graph.addNode(node);
        graph.addRelationship({ from: fileId, to: node.id, type: "DECLARES_ROUTE", properties: {} });
        routes.push(node);
      }
    }

    const mountsOf = (functionId: string, index: number, depth: number, seen: Set<string>, fromTests: boolean): Mount[] => {
      const key = `${functionId}\0${index}`;
      if (depth > MAX_MOUNT_DEPTH || seen.has(key)) return [];
      const mounts: Mount[] = [];
      for (const { argument, callerFunctionId, fileId } of argumentsByFunction.get(functionId) ?? []) {
        if (argument.index !== index || (!fromTests && testFiles.has(fileId))) continue;
        const own = argument.middleware.map((ref) => ({ ref, fileId }));
        if (argument.base === null) {
          mounts.push({ prefix: argument.prefix, middleware: own });
          continue;
        }
        const outers = mountsOf(callerFunctionId, argument.base, depth + 1, new Set([...seen, key]), fromTests);
        // The caller returns its router and nothing mounts it: it is a root.
        if (outers.length === 0 && argument.base === RETURNED_ROUTER) mounts.push({ prefix: argument.prefix, middleware: own });
        for (const outer of outers) {
          mounts.push({
            prefix: outer.prefix === null || argument.prefix === null ? null : joinRoutePaths(outer.prefix, argument.prefix, true),
            middleware: [...outer.middleware, ...own],
          });
        }
      }
      return mounts;
    };

    const fileByRoute = new Map<string, string>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "DECLARES_ROUTE") fileByRoute.set(relationship.to, relationship.from);
    }

    const newNodes: GraphNode[] = [];
    const newRelationships: GraphRelationship[] = [];
    for (const route of routes) {
      const pending = JSON.parse(String(route.properties.goPending)) as GoPendingRoute;
      delete route.properties.goPending;
      const fileId = fileByRoute.get(route.id);
      if (!fileId) continue;
      const ownSteps = pending.middleware.map((ref) => ({ ref, fileId }));
      const handler = pending.handler ? { ref: pending.handler, fileId } : null;

      if (pending.base === null) {
        newRelationships.push(...routeRelationships(route.id, ownSteps, handler, goIndex));
        continue;
      }

      // One Route per distinct path a mount gives it.
      const mounts = [...new Map(mountsOf(String(route.properties.scopeFunctionId), pending.base, 0, new Set(), testFiles.has(fileId))
        .map((mount) => [`${mount.prefix}\0${mount.middleware.map((step) => step.ref.expression).join("\0")}`, mount])).values()];
      if (mounts.length === 0) {
        newRelationships.push(...routeRelationships(route.id, ownSteps, handler, goIndex));
        continue;
      }
      mounts.forEach((mount, index) => {
        const node = index === 0 ? route : { ...route, id: `${route.id}#${index}`, properties: { ...route.properties } };
        node.properties.fullPath = mount.prefix === null || pending.path === null ? null : joinRoutePaths(mount.prefix, pending.path);
        if (mount.prefix === null) node.properties.pathExpression = "<dynamic group path>";
        if (index > 0) {
          newNodes.push(node);
          newRelationships.push({ from: fileId, to: node.id, type: "DECLARES_ROUTE", properties: {} });
        }
        newRelationships.push(...routeRelationships(node.id, [...mount.middleware, ...ownSteps], handler, goIndex));
      });
    }
    graph.addNodes(newNodes);
    graph.addRelationships(newRelationships);
  },
};

function routeRelationships(
  routeId: string,
  middleware: Array<{ ref: GoHandlerRef; fileId: string }>,
  handler: { ref: GoHandlerRef; fileId: string } | null,
  index: GoCallIndex,
): GraphRelationship[] {
  const relationships: GraphRelationship[] = [];
  const steps = [
    ...middleware.map((step) => ({ ...step, role: "middleware", hook: null as string | null })),
    ...handler ? [{ ...handler, role: "handler", hook: "handler" }] : [],
  ];
  const resolved = steps
    .map((step) => ({ step, functionId: resolveRef(step.ref, step.fileId, index) }))
    .filter((entry): entry is typeof entry & { functionId: string } => entry.functionId !== null);

  const handlerId = handler ? resolved.find((entry) => entry.step.role === "handler")?.functionId : undefined;
  if (handlerId) relationships.push({ from: routeId, to: handlerId, type: "ROUTE_HANDLED_BY", properties: {} });

  resolved.forEach(({ step, functionId }, orderIndex) => {
    relationships.push({
      from: routeId,
      to: functionId,
      type: "ROUTE_LIFECYCLE_STEP",
      properties: { role: step.role, scope: step.ref.scope, hook: step.hook, orderIndex },
    });
  });
  for (let orderIndex = 0; orderIndex < resolved.length - 1; orderIndex += 1) {
    relationships.push({
      from: resolved[orderIndex]!.functionId,
      to: resolved[orderIndex + 1]!.functionId,
      type: "LIFECYCLE_PRECEDES",
      properties: { routeId, scope: resolved[orderIndex]!.step.ref.scope, orderIndex },
    });
  }
  return relationships;
}

function resolveRef(ref: GoHandlerRef, fileId: string, index: GoCallIndex): string | null {
  if (ref.functionId) return ref.functionId;
  const call: GraphNode = { id: `${fileId}:handler:${ref.expression}`, label: "Call", properties: { ...ref } };
  return resolveGoCall(call, fileId, index)[0]?.functionId ?? null;
}
