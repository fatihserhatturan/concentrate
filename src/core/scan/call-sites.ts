import type { GraphBuilder } from "../graph/builder.js";
import type { GraphNode, GraphRelationship } from "../graph/model.js";

type Site = { callee: string; line: number; column: number; expression: string };

// Relationships that tie a Call to anything but the code that makes it. A call
// with one of these is a node a tool can reach (a resolved call, a callback, a
// request), so it stays.
const OTHER_CALL_RELATIONSHIPS = ["CALL_RESOLVES_TO", "PASSED_TO", "INITIALIZED_BY", "REQUESTS", "NAVIGATES_TO"] as const;

// An outbound request or a store access the scan saw but could not match to a
// route or a store is a fact in itself (tests and tools read it off the node),
// so a call with one of these stays a node even without other relationships.
const CARRIES_FACTS = ["httpClient", "storeAccess", "reduxAccess"] as const;

/**
 * Turn the call sites that nothing resolved into a property of their caller.
 * On a large repository three quarters of all Call nodes are library and
 * dynamic calls whose only relationship is the CALLS or MODULE_CALLS edge from
 * their caller; as nodes they were half the graph's memory. Run it after every
 * resolver and contributor, which still see all calls. Each such call leaves
 * the graph and its caller (a Function, or the File for module-level code) gets
 * `unresolvedCalls`: a JSON array of `[callee, line, expression]` sorted by
 * line, column and expression.
 */
export function compactUnresolvedCalls(graph: GraphBuilder): void {
  const keep = new Set<string>();
  for (const type of OTHER_CALL_RELATIONSHIPS) {
    for (const relationship of graph.relationshipsOfType(type)) {
      keep.add(type === "CALL_RESOLVES_TO" || type === "REQUESTS" || type === "NAVIGATES_TO" ? relationship.from : relationship.to);
    }
  }

  const callers = [...graph.relationshipsOfType("CALLS"), ...graph.relationshipsOfType("MODULE_CALLS")];
  const incoming = new Map<string, number>();
  for (const relationship of callers) incoming.set(relationship.to, (incoming.get(relationship.to) ?? 0) + 1);

  const removedNodes = new Set<GraphNode>();
  const removedRelationships = new Set<GraphRelationship>();
  const sitesByCaller = new Map<GraphNode, Site[]>();
  for (const relationship of callers) {
    if (keep.has(relationship.to) || incoming.get(relationship.to) !== 1) continue;
    const call = graph.node(relationship.to);
    const caller = graph.node(relationship.from);
    if (!call || call.label !== "Call" || CARRIES_FACTS.some((name) => call.properties[name] !== undefined) || !caller || (caller.label !== "Function" && caller.label !== "File")) continue;
    const properties = call.properties;
    const expression = String(properties.expression ?? properties.name ?? "");
    const site: Site = {
      callee: String(properties.callee ?? properties.name ?? expression),
      line: Number(properties.line ?? 0),
      column: Number(properties.columnNumber ?? 0),
      expression,
    };
    const sites = sitesByCaller.get(caller);
    if (sites) sites.push(site);
    else sitesByCaller.set(caller, [site]);
    removedNodes.add(call);
    removedRelationships.add(relationship);
  }

  for (const [caller, sites] of sitesByCaller) {
    sites.sort((a, b) => a.line - b.line || a.column - b.column || compare(a.expression, b.expression) || compare(a.callee, b.callee));
    caller.properties.unresolvedCalls = JSON.stringify(sites.map((site) => [site.callee, site.line, site.expression]));
  }
  graph.removeRelationships(removedRelationships);
  graph.removeNodes(removedNodes);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
