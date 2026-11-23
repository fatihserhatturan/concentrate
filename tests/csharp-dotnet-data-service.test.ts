import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import type { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { openTestStore } from "./helpers/store.js";

// Acceptance (phase 47): one .NET service with controllers and minimal endpoints, an EF Core DbContext, a Dapper
// repository, appsettings.json / appsettings.Production.json, IOptions<T>, environment variables, a typed HttpClient and
// a Refit client, all wired through DI. The graph is written to the store; tables, data access, env/config usage and
// outbound requests answer through the MCP tools, and impact_of reaches routes through the injected interfaces.

type Json = Record<string, any>;

describe("C# data, config and HTTP acceptance through the MCP tools (fixtures/csharp-dotnet-data-service)", () => {
  let store: GraphStore;
  let directory: string;
  let relationships: Array<{ from: string; to: string; type: string }>;
  let tool: (name: string, args?: Record<string, unknown>) => Promise<Json>;
  before(async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures", "csharp-dotnet-data-service"), { continueOnError: false });
    relationships = graph.relationships;
    directory = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-data-acceptance-"));
    store = await openTestStore(path.join(directory, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
    tool = async (name, args = {}) => JSON.parse((await callMcpTool(store, name, args)).content[0]?.text ?? "{}") as Json;
  });
  after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const routeList = (table: Json): string[] =>
    table.routes.map((route: Json) => `${route.method} ${route.path} ${(route.reads ?? []).join("+")}|${(route.writes ?? []).join("+")}`).sort();
  const reached = (impact: Json): string[] => impact.routes.map((route: Json) => `${route.method} ${route.fullPath}`).sort();

  it("list_tables: EF Core and Dapper tables with columns and the routes that read and write them", async () => {
    const { tables } = await tool("list_tables");
    assert.deepEqual(tables.map((table: Json) => `${table.name} ${table.library}`), ["order_lines efcore", "orders efcore", "shipments dapper"]);
    const byName = (name: string): Json => tables.find((table: Json) => table.name === name);
    assert.equal(byName("order_lines").schemaName, "fulfilment");
    assert.deepEqual(byName("orders").columns.map((column: Json) => column.name), ["Id", "CustomerEmail", "Status"]);
    // The columns of the SQL-only table come from schema.sql.
    assert.deepEqual(byName("shipments").columns.map((column: Json) => column.name), ["id", "order_id", "tracking_code", "status"]);
    assert.deepEqual(routeList(byName("orders")), [
      "DELETE /api/orders/{id} read|delete",
      "GET /api/orders/{id} read|",
      "GET /minimal/orders/{id} read|",
      "POST /api/orders |create",
    ]);
    assert.deepEqual(routeList(byName("shipments")), ["GET /api/shipments/{orderId} read|", "POST /api/shipments/{orderId}/dispatch |create"]);
    // A minimal-API lambda reaches only what it calls: no table on /health, /api/stock/..., /api/prices/..., nor on the program entrypoint.
    assert.deepEqual(byName("orders").entrypoints, []);
    assert.deepEqual(byName("shipments").entrypoints, []);
  });

  it("list_data_access: EF Core and Dapper calls, direct and through the injected callers", async () => {
    const direct = await tool("list_data_access", { direct: true, limit: 100 });
    assert.deepEqual(
      direct.dataAccess.map((item: Json) => `${item.library} ${item.sourceName} ${item.table} ${item.operation}`).sort(),
      [
        "dapper ForOrderAsync shipments read",
        "dapper RecordAsync shipments create",
        "efcore CancelAsync orders delete",
        "efcore CancelAsync orders read",
        "efcore CreateAsync orders create",
        "efcore FindAsync orders read",
      ],
    );
    const callers = await tool("list_data_access", { model: "shipments", operation: "create", limit: 100 });
    const names = callers.dataAccess.map((item: Json) => `${item.sourceName} ${item.direct}`).sort();
    // The route itself is a source too (its `sourceName` is the path), next to the controller action and the service.
    assert.deepEqual(names, ["/api/shipments/{orderId}/dispatch false", "Dispatch false", "DispatchAsync false", "RecordAsync true"]);
  });

  it("list_env_config: appsettings values (secrets redacted), the keys read, and environment variables", async () => {
    const connection = await tool("list_env_config", { name: "ConnectionStrings", limit: 100 });
    const values = connection.envConfig.filter((item: Json) => item.kind === "config").map((item: Json) => `${item.file} ${item.value}`).sort();
    assert.deepEqual(values, [
      "appsettings.Production.json Server=sql.prod.internal;Database=fulfilment;User Id=app;Password=<redacted>;",
      "appsettings.json Server=localhost;Database=fulfilment;User Id=app;Password=<redacted>;",
    ]);
    const readers = connection.envConfig.filter((item: Json) => item.kind === "env" && item.name === "ConnectionStrings__Fulfilment").map((item: Json) => item.file).sort();
    assert.deepEqual(readers, ["Program.cs", "Repositories/ShipmentRepository.cs"]);
    assert.ok(!JSON.stringify(connection).includes("prod-password") && !JSON.stringify(connection).includes("dev-password"));

    const carriers = await tool("list_env_config", { name: "Carriers", limit: 100 });
    const key = carriers.envConfig.find((item: Json) => item.kind === "config" && item.name === "Carriers:ApiKey");
    assert.equal(key.value, "<redacted>");
    // IOptions<CarrierOptions> consumers: ShipmentService reads the section through the injected options.
    assert.ok(carriers.envConfig.some((item: Json) => item.kind === "config-consumer" && item.file === "Services/ShipmentService.cs"));

    const region = await tool("list_env_config", { name: "FULFILMENT_REGION" });
    assert.deepEqual(region.envConfig.map((item: Json) => `${item.file} ${item.name}`), ["Services/ShipmentService.cs FULFILMENT_REGION"]);
  });

  it("environment reads of the /health lambda stay on that route, not on every minimal route", async () => {
    const envOf = (routeSuffix: string): string[] =>
      relationships.filter((rel) => rel.type === "USES_ENV" && rel.from.includes(":route:") && rel.from.endsWith(routeSuffix)).map((rel) => rel.to).sort();
    assert.deepEqual(envOf(":GET:/health"), ["env:WEBSITE_SITE_NAME"]);
    assert.deepEqual(envOf(":GET:/api/prices/{sku}"), []);
    assert.deepEqual(envOf(":GET:/minimal/orders/{id}"), []);
  });

  it("api_consumers: the typed HttpClient and the Refit client reach the service's own routes", async () => {
    const all = await tool("api_consumers", { limit: 100 });
    assert.deepEqual(
      all.consumers.map((item: Json) => `${item.client} ${item.method} ${item.route.fullPath} <- ${item.function}`).sort(),
      [
        "httpclient-factory GET /api/stock/{sku} <- StockAsync",
        "httpclient-factory POST /api/stock/{sku}/reserve <- ReserveAsync",
        "refit GET /api/prices/{sku} <- PlaceAsync",
      ],
    );
    const refit = await tool("api_consumers", { client: "refit" });
    assert.equal(refit.consumers.length, 1);
    assert.equal(refit.consumers[0].file, "Services/OrderService.cs");
  });

  it("impact_of the Dapper repository, the EF repository and the HTTP client reach controller routes through DI", async () => {
    const dapper = await tool("impact_of", { symbol: "RecordAsync", file: "ShipmentRepository.cs" });
    assert.deepEqual(reached(dapper), ["POST /api/shipments/{orderId}/dispatch"]);
    const ef = await tool("impact_of", { symbol: "CreateAsync", file: "OrderRepository.cs" });
    assert.deepEqual(reached(ef), ["POST /api/orders"]);
    const client = await tool("impact_of", { symbol: "ReserveAsync", file: "InventoryClient.cs" });
    assert.deepEqual(reached(client), ["POST /api/orders"]);
    const read = await tool("impact_of", { symbol: "FindAsync", file: "OrderRepository.cs" });
    for (const route of ["GET /api/orders/{id}", "GET /minimal/orders/{id}"]) assert.ok(reached(read).includes(route), route);
  });
});
