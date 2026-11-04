import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

describe("Go outbound HTTP", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-http-clients"), { continueOnError: false });
  });

  it("records net/http and resty requests with their method and URL", () => {
    const requests = graph.nodes
      .filter((node) => node.label === "Call" && node.properties.httpClient !== undefined)
      .map((node) => `${node.properties.expression} ${node.properties.httpClient} ${node.properties.httpMethod} ${node.properties.httpUrl}`)
      .sort();
    assert.deepEqual(requests, [
      // A struct field's base URL is not resolved.
      "c.http.Get net/http GET ${c.baseURL}/orders",
      "c.http.Get net/http GET /api/products/${id}",
      "client.R().Execute resty GET /health",
      // A local origin is dropped; the query string too.
      "http.Get net/http GET /api/products",
      "http.Get net/http GET /health",
      "http.NewRequest net/http DELETE /api/products/${id}",
      "http.NewRequestWithContext net/http POST /api/products",
      // SetBaseURL joined to a constant of another file.
      "o.api.R().SetPathParam(\"id\", id).Get resty GET /api/orders/${id}/items",
      "req.Put resty PUT /api/orders/${id}",
    ]);
    assert.ok(graph.nodes.every((node) => !("goHttpBase" in node.properties) && !("goStringTemplate" in node.properties)));
  });

  it("links each request to the route it reaches", () => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const links = graph.relationships
      .filter((rel) => rel.type === "REQUESTS")
      .map((rel) => `${byId.get(rel.from)!.properties.line} ${rel.properties.method} ${byId.get(rel.to)!.properties.fullPath} ${rel.properties.match}`)
      .sort();
    assert.deepEqual(links, [
      "16 GET /api/orders/{id}/items parameter",
      "22 PUT /api/orders/{id} parameter",
      "23 GET /health exact",
      "28 GET /health exact",
      "29 GET /api/products/{id} parameter",
      "36 POST /api/products exact",
      "46 DELETE /api/products/{id} parameter",
      "53 GET /api/products exact",
    ]);
  });

  it("api_consumers lists the Go callers of a route", async () => {
    const store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-go-http-")), "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const result = (await callMcpTool(store, "api_consumers", { method: "GET", path: "/health" })).structuredContent as Record<string, any>;
      assert.deepEqual(result.consumers.map((row: any) => row.client).sort(), ["net/http", "resty"]);
    } finally {
      await store.close();
    }
  });
});
