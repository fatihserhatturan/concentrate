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

describe("Rust outbound HTTP", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/rust-http"), { continueOnError: false });
  });

  it("records reqwest requests with their method and URL", () => {
    const requests = graph.nodes
      .filter((node) => node.label === "Call" && node.properties.httpClient !== undefined)
      .map((node) => `${node.properties.line} ${node.properties.expression} ${node.properties.httpClient} ${node.properties.httpMethod} ${node.properties.httpUrl}`)
      .sort((a, b) => parseInt(a) - parseInt(b));
    assert.deepEqual(requests, [
      // A struct field's base URL is not resolved.
      "13 self.http.get reqwest GET ${self.base}/api/products/${id}",
      // A local `format!` over a const; the origin is dropped by the api-origin rules.
      "18 self.http.post reqwest POST /api/products",
      "23 reqwest::get reqwest GET /health",
      // The query string is dropped.
      "27 client.get reqwest GET /api/products",
      "32 client.delete reqwest DELETE /api/products/${id}",
      "33 client.request reqwest DELETE /api/products/1",
      // A static client, and the URL an `.env` file gives for ORDERS_URL.
      "38 SHARED.get reqwest GET /api/orders",
      // A call chained on a constructor has no Call node of its own; one is made.
      "42 reqwest::blocking::Client::new().get reqwest GET /api/orders",
    ]);
    // `HashMap::get` is not a client.
    assert.ok(graph.nodes.every((node) => !(node.label === "Call" && node.properties.httpClient && node.properties.line === 46)));
  });

  it("links each request to the route it reaches", () => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const links = graph.relationships
      .filter((rel) => rel.type === "REQUESTS")
      .map((rel) => `${byId.get(rel.from)!.properties.line} ${rel.properties.method} ${byId.get(rel.to)!.properties.fullPath} ${rel.properties.match}`)
      .sort((a, b) => parseInt(a) - parseInt(b));
    assert.deepEqual(links, [
      "18 POST /api/products exact",
      "23 GET /health exact",
      "27 GET /api/products exact",
      "32 DELETE /api/products/:id parameter",
      "33 DELETE /api/products/:id parameter",
      "38 GET /api/orders exact",
      "42 GET /api/orders exact",
    ]);
  });

  it("api_consumers lists the Rust callers of a route", async () => {
    const store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-rust-http-")), "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const result = (await callMcpTool(store, "api_consumers", { method: "GET", path: "/health" })).structuredContent as Record<string, any>;
      assert.deepEqual(result.consumers.map((row: any) => row.client), ["reqwest"]);
    } finally {
      await store.close();
    }
  });
});
