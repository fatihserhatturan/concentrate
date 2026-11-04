import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

describe("Go routers built in another package", () => {
  let graph: Graph;
  let byId: Map<string, GraphNode>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-split-router"), { continueOnError: false });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });

  it("gives full paths to routes on a router another package returns", () => {
    const routes = graph.nodes
      .filter((node) => node.label === "Route")
      .map((node) => `${node.properties.method} ${node.properties.fullPath}`)
      .sort();
    assert.deepEqual(routes, ["GET /api/items", "GET /api/items/", "GET /api/items/:name", "GET /health"]);
    assert.ok(graph.nodes.every((node) => !("goPending" in node.properties) && !("routerArguments" in node.properties)));
  });

  it("links each URL to the route with the same trailing slash", () => {
    const links = graph.relationships
      .filter((rel) => rel.type === "REQUESTS")
      .map((rel) => `${rel.properties.url} -> ${byId.get(rel.to)!.properties.fullPath} ${rel.properties.match}`)
      .sort();
    assert.deepEqual(links, ["/api/items -> /api/items exact", "/api/items/ -> /api/items/ exact"]);
  });

  it("resolves calls on locals typed by a method result and by range", () => {
    const resolved = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO")
      .map((rel) => `${byId.get(rel.from)!.properties.expression} -> ${byId.get(rel.to)!.properties.className}.${byId.get(rel.to)!.properties.name}`);
    // `item, err := h.items.Find(…)` (interface field, one implementer) and
    // `for _, item := range items` over `[]model.Item`.
    assert.equal(resolved.filter((link) => link === "item.Label -> Item.Label").length, 2);
  });
});
