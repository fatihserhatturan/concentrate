import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import type { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { openTestStore } from "./helpers/store.js";

// Acceptance (phase 42): one Spring Boot service that uses JPA / Spring Data, JdbcTemplate and MyBatis on the
// same `orders` table, `@Value` / `@ConfigurationProperties` / `System.getenv` / `${ENV}` placeholders, and a
// Feign client and a WebClient that call two other routes of the same app, all reached from REST controllers.
// The Java phase 42 features must meet in one graph: one Table, one set of env names, requests linked to routes.

type Json = Record<string, any>;

describe("Java data, config and HTTP acceptance through the MCP tools (fixtures/java-spring-service)", () => {
  let store: GraphStore;
  let directory: string;
  let tool: (name: string, args?: Record<string, unknown>) => Promise<Json>;
  before(async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures", "java-spring-service"), { continueOnError: false });
    directory = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-service-acceptance-"));
    store = await openTestStore(path.join(directory, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
    tool = async (name, args = {}) => JSON.parse((await callMcpTool(store, name, args)).content[0]?.text ?? "{}") as Json;
  });
  after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const labels = (rows: Json[]) => rows.map((row) => `${row.className}.${row.name}`);
  const routes = (impact: Json) => impact.routes.map((route: Json) => `${route.method} ${route.fullPath}`).sort();

  it("list_tables: JPA, JDBC (SQL spelled ORDERS) and MyBatis meet in one orders table", async () => {
    const result = await tool("list_tables");
    assert.equal(result.totalTables, 1);
    const [table] = result.tables;
    assert.equal(table.name, "orders");
    assert.equal(table.library, "jpa");
    assert.deepEqual(table.columns.map((column: Json) => column.name), ["id", "customerEmail", "status"]);
    assert.deepEqual(
      table.models.map((model: Json) => model.name).sort(),
      ["OrderEntity", "OrderRepository", "orders", "orders"],
    );
    assert.deepEqual(
      table.routes.map((route: Json) => `${route.method} ${route.path} r=${(route.reads ?? []).join()} w=${(route.writes ?? []).join()}`),
      [
        "POST /api/orders r=aggregate w=upsert",
        "GET /api/orders r=read w=",
        "PUT /api/orders/{id}/ship r= w=update",
        "GET /api/orders/by-customer/{email} r=read w=",
        "DELETE /api/orders/cancelled r= w=delete",
      ],
    );
  });

  it("list_data_access: every library of the table, with the routes that reach it", async () => {
    const result = await tool("list_data_access", { direct: true, limit: 100 });
    const rows = result.dataAccess.map((row: Json) => `${row.library} ${row.sourceName} ${row.table} ${row.operation}`).sort();
    assert.deepEqual(rows, [
      "jdbc markShipped orders update",
      "jdbc openCount orders aggregate",
      "jpa countByCustomerEmail orders aggregate",
      "jpa findByStatus orders read",
      "jpa place orders upsert",
      "mybatis byCustomer orders read",
      "mybatis purgeCancelled orders delete",
    ]);
    const libraries = new Set((await tool("list_data_access", { limit: 100 })).dataAccess.map((row: Json) => row.library));
    assert.deepEqual([...libraries].sort(), ["jdbc", "jpa", "mybatis"]);
    // The functions that call the data layer reach the table transitively, up to the controllers.
    const viaCallers = (await tool("list_data_access", { library: "mybatis", limit: 100 })).dataAccess;
    assert.ok(viaCallers.some((row: Json) => row.sourceName === "forCustomer" && row.direct === false));
  });

  it("list_env_config: the Java env variables and config keys of the service", async () => {
    const result = await tool("list_env_config", { limit: 100 });
    const env = result.envConfig.filter((row: Json) => row.kind === "env").map((row: Json) => `${row.name} ${row.value}`).sort();
    assert.deepEqual(env, [
      "AUDIT_URL config placeholder",
      "DB_HOST config placeholder",
      "DB_PASSWORD config placeholder",
      "NOTIFY_URL config placeholder",
      "ORDERS_REGION System.getenv",
    ]);
    const keys = result.envConfig.filter((row: Json) => row.kind === "config").map((row: Json) => row.name);
    assert.deepEqual(keys, [
      "app.name",
      "app.limits.max-open",
      "app.limits.page-size",
      "app.notify.base-url",
      "services.audit.url",
      "spring.datasource.url",
      "spring.datasource.password",
    ]);
    // @Value fields and @ConfigurationProperties fields consume the keys.
    const consumers = result.envConfig
      .filter((row: Json) => row.kind === "config-consumer")
      .map((row: Json) => `${row.name} ${path.basename(row.file)} ${row.consumer}`)
      .sort();
    assert.deepEqual(consumers, [
      "app.limits.max-open LimitProperties.java maxOpen",
      "app.limits.max-open OrderService.java maxOpen",
      "app.limits.page-size LimitProperties.java pageSize",
      "app.name OrderService.java appName",
      "app.notify.base-url NotifyGateway.java baseUrl",
    ]);
    const filtered = await tool("list_env_config", { name: "ORDERS_REGION" });
    assert.deepEqual(filtered.envConfig.map((row: Json) => row.name), ["ORDERS_REGION"]);
  });

  it("api_consumers: the Feign client and the WebClient reach their routes of the same app, with config placeholders resolved", async () => {
    const audit = await tool("api_consumers", { method: "POST", path: "/api/audit/events" });
    assert.deepEqual(
      audit.consumers.map((row: Json) => `${row.client} ${row.function} ${row.match} ${row.route.file}`),
      ["feign place exact src/main/java/com/acme/orders/web/AuditController.java"],
    );
    const notify = await tool("api_consumers", { method: "POST", path: "/api/notify/send" });
    assert.deepEqual(
      notify.consumers.map((row: Json) => `${row.client} ${row.function} ${row.match} ${row.route.file}`),
      ["webclient send exact src/main/java/com/acme/orders/web/NotifyController.java"],
    );
  });

  it("impact_of the data layer reaches the routes, whichever library the table is written with", async () => {
    const jpa = await tool("impact_of", { symbol: "findByStatus", file: "OrderRepository.java" });
    assert.deepEqual(labels(jpa.seeds), ["OrderRepository.findByStatus"]);
    assert.deepEqual(routes(jpa), ["GET /api/orders"]);

    const jdbc = await tool("impact_of", { symbol: "markShipped" });
    assert.deepEqual(routes(jdbc), ["PUT /api/orders/{id}/ship"]);

    const mybatis = await tool("impact_of", { symbol: "purgeCancelled", file: "OrderMapper.java" });
    assert.deepEqual(routes(mybatis), ["DELETE /api/orders/cancelled"]);
  });

  it("impact_of the code that reads a config key or an env variable reaches the routes", async () => {
    // `place` reads app.name, app.limits.max-open and the audit service URL, and calls the Feign client.
    const place = await tool("impact_of", { symbol: "place", file: "OrderService.java" });
    assert.deepEqual(routes(place), ["POST /api/orders"]);
    const region = await tool("impact_of", { symbol: "region", file: "OrderService.java" });
    assert.deepEqual(routes(region), ["GET /api/orders/region"]);
  });
});
