import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

describe("Python outbound HTTP", () => {
  let graph: Graph;
  let store: GraphStore;

  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/python-http-clients"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-python-http-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("records requests, httpx and aiohttp calls with their method and URL", () => {
    const calls = graph.nodes
      .filter((node) => node.label === "Call" && node.properties.httpClient !== undefined && node.properties.httpClient !== "fetch")
      .map((node) => `${node.properties.expression} ${node.properties.httpClient} ${node.properties.httpMethod} ${node.properties.httpUrl}`)
      .sort();
    assert.deepEqual(calls, [
      // An AsyncClient with a base_url, and the origin of a local URL dropped.
      "client.get httpx GET /api/products",
      "http.get aiohttp GET /api/products",
      // `from requests import get as http_get`.
      "http_get requests GET /health",
      // `${env:UPSTREAM_URL}` read from the nearest .env, the query string dropped.
      "httpx.get httpx GET /api/products",
      "requests.delete requests DELETE /api/products/${item}",
      "requests.get requests GET /api/products",
      // `request("PUT", "…%s" % id)`.
      "requests.request requests PUT /api/orders/${_}",
      // A class constant in an f-string, joined to the client's base_url.
      "self.client.get httpx GET /api/products/${product_id}",
      // A module constant and `f"{BASE}{ORDERS}"` on a `requests.Session()`.
      "session.post requests POST /api/orders",
    ]);
    // The in-process `httpx.Client(app=app)` and `cache.get("key")` are not requests.
    assert.ok(graph.nodes.every((node) => node.properties.httpClient === undefined || !/local\.get|cache\.get|\{\}\.get/u.test(String(node.properties.expression))));
    assert.ok(graph.nodes.every((node) => node.properties.httpUrl === undefined || !String(node.properties.httpUrl).includes("${env:")));
  });

  it("links each request to the route it reaches, the TypeScript client's too", () => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const links = graph.relationships
      .filter((rel) => rel.type === "REQUESTS")
      .map((rel) => `${byId.get(rel.from)!.properties.line} ${rel.properties.method} ${byId.get(rel.to)!.properties.fullPath} ${rel.properties.match}`)
      .sort();
    assert.deepEqual(links, [
      "11 POST /api/orders exact",
      "2 GET /api/products exact",
      "21 GET /api/products/{product_id} parameter",
      "25 GET /api/products exact",
      "29 GET /health exact",
      "33 POST /api/orders exact",
      "37 PUT /api/orders/{order_id} parameter",
      "41 GET /api/products exact",
      "50 GET /api/products exact",
      "52 GET /api/products exact",
      "7 GET /api/products/{product_id} parameter",
    ]);
  });

  it("api_consumers lists the Python and TypeScript callers of a route", async () => {
    const result = (await callMcpTool(store, "api_consumers", { method: "GET", path: "/api/products" })).structuredContent as Record<string, any>;
    assert.deepEqual([...new Set(result.consumers.map((row: any) => row.client))].sort(), ["aiohttp", "fetch", "httpx", "requests"]);
    const files = new Set(result.consumers.map((row: any) => row.file));
    assert.ok(files.has("web/api.ts") && files.has("workers/client.py"));
  });
});
