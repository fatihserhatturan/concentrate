import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import type { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { openTestStore } from "./helpers/store.js";

// Acceptance (phase 46): one ASP.NET Core service with controllers, minimal APIs (MapGroup, injected handler parameters),
// a gRPC service and client, a SignalR hub, a BackgroundService, an IHostedService and DI registrations with single and
// ambiguous implementations. The graph must be written to the store and answer list_routes / impact_of.

type Json = Record<string, any>;

describe("C# ASP.NET Core acceptance through the MCP tools (fixtures/csharp-aspnet-service)", () => {
  let store: GraphStore;
  let directory: string;
  let tool: (name: string, args?: Record<string, unknown>) => Promise<Json>;
  before(async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures", "csharp-aspnet-service"), { continueOnError: false });
    directory = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-service-acceptance-"));
    store = await openTestStore(path.join(directory, "graph"));
    await store.reset();
    // Regression: the Phase 45 acceptance test caught a store-write crash; every edge this phase adds must fit the schema.
    await store.write(graph.nodes, graph.relationships);
    tool = async (name, args = {}) => JSON.parse((await callMcpTool(store, name, args)).content[0]?.text ?? "{}") as Json;
  });
  after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const routes = (impact: Json) => impact.routes.map((route: Json) => `${route.method} ${route.fullPath}`).sort();
  const entrypoints = (impact: Json) => impact.entrypoints.map((entry: Json) => `${entry.kind} ${entry.trigger}`).sort();

  it("list_routes: controller and minimal API routes with their handlers and MapGroup prefixes", async () => {
    const result = await tool("list_routes", { limit: 100 });
    assert.deepEqual(
      result.routes.map((route: Json) => `${route.framework} ${route.method} ${route.fullPath} ${route.handler}`),
      [
        "aspnet-mvc GET /api/Stock/{sku} Get",
        "aspnet-mvc POST /api/Stock/{sku}/reserve Reserve",
        "aspnet-mvc POST /api/alerts Raise",
        "aspnet-minimal GET /minimal/v1/stock/{sku} Peek",
        "aspnet-minimal POST /minimal/v1/stock/{sku}/reserve <top-level>",
        "aspnet-minimal POST /minimal/v1/alerts Notify",
        "aspnet-minimal GET /health <top-level>",
      ],
    );
  });

  it("impact_of the repository implementation reaches routes, hosted services and gRPC through the injected interfaces", async () => {
    const impact = await tool("impact_of", { symbol: "Save", file: "Implementations.cs" });
    assert.deepEqual(impact.seeds.map((seed: Json) => `${seed.className}.${seed.name}`), ["SqlStockRepository.Save"]);
    const reached = routes(impact);
    assert.ok(reached.includes("POST /api/Stock/{sku}/reserve"), "controller route");
    assert.ok(reached.includes("POST /minimal/v1/stock/{sku}/reserve"), "minimal API lambda route");
    // Only mutating paths: the read-only routes are not reached.
    assert.ok(!reached.includes("GET /api/Stock/{sku}") && !reached.includes("GET /minimal/v1/stock/{sku}"));
    const entries = entrypoints(impact);
    for (const expected of ["grpc Stocker/Reserve", "hosted-service ReplenishWorker", "hosted-service AuditFlusher"]) assert.ok(entries.includes(expected), expected);
    assert.ok(!entries.includes("grpc Stocker/Check"));
  });

  it("impact_of a read reaches the method-group minimal API route, the controller route and the gRPC and SignalR entrypoints", async () => {
    const impact = await tool("impact_of", { symbol: "Find", file: "Implementations.cs" });
    const reached = routes(impact);
    assert.ok(reached.includes("GET /minimal/v1/stock/{sku}"), "method-group handler route");
    assert.ok(reached.includes("GET /api/Stock/{sku}"));
    const entries = entrypoints(impact);
    assert.ok(entries.includes("grpc Stocker/Check"));
    assert.ok(entries.includes("signalr StockHub/Watch"));
  });

  it("the gRPC client call reaches the service implementation", async () => {
    const impact = await tool("impact_of", { symbol: "Check", file: "StockGrpcService.cs" });
    assert.ok(impact.callers.some((caller: Json) => caller.className === "StockProbe" && caller.name === "IsKnown"));
  });

  it("the SignalR hub path has the MapGroup prefix applied", async () => {
    const rows = await store.query("MATCH (e:EntryPoint {kind: 'signalr'}) RETURN e.trigger AS trigger, e.hubPath AS hubPath");
    assert.deepEqual(rows.map((row) => `${row.trigger} ${row.hubPath}`), ["StockHub/Watch /realtime/stock"]);
  });

  it("DI: single registrations link, the ambiguous INotifier is counted, handler parameters inject (INJECTS stored)", async () => {
    const rows = await store.query(
      "MATCH (a:Class)-[r:INJECTS]->(b:Class) RETURN a.name AS consumer, b.name AS target, r.fieldName AS field, r.via AS via",
    );
    const edges = rows.map((row) => `${row.consumer}->${row.target} ${row.field} ${row.via}`).sort();
    assert.deepEqual(edges, [
      "AuditFlusher->SqlStockRepository repository constructor",
      "ReplenishWorker->StockService stock constructor",
      "StockController->StockService stock constructor",
      "StockGrpcService->StockService stock constructor",
      "StockHandlers->StockService service handler-parameter",
      "StockHub->StockService stock constructor",
      "StockService->SqlStockRepository repository constructor",
      "StockService->SystemClock clock constructor",
    ]);
    const ambiguous = await store.query("MATCH (c:Class) WHERE c.ambiguousInjections > 0 RETURN c.name AS name, c.ambiguousInjections AS count ORDER BY name");
    assert.deepEqual(ambiguous.map((row) => `${row.name} ${row.count}`), ["AlertsController 1", "AuditFlusher 1", "StockHandlers 1"]);
  });
});
