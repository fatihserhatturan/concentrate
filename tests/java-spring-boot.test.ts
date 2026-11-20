import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import type { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { openTestStore } from "./helpers/store.js";

// Acceptance: a realistic Spring Boot service answered through the MCP tools. Controller -> service ->
// repository interface -> its one @Repository implementation, plus a @Scheduled job and a @KafkaListener.

type Json = Record<string, any>;

describe("Java framework acceptance through the MCP tools", () => {
  const tmp: string[] = [];
  const stores: GraphStore[] = [];
  const openFixture = async (name: string) => {
    const graph = await buildCodeGraph(path.resolve("fixtures", name), { continueOnError: false });
    const directory = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-acceptance-"));
    tmp.push(directory);
    const store = await openTestStore(path.join(directory, "graph"));
    stores.push(store);
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
    return async (tool: string, args: Record<string, unknown> = {}): Promise<Json> => JSON.parse((await callMcpTool(store, tool, args)).content[0]?.text ?? "{}") as Json;
  };
  after(async () => {
    for (const store of stores) await store.close();
    for (const directory of tmp) await rm(directory, { recursive: true, force: true });
  });

  describe("fixtures/java-spring-boot", () => {
    let tool: Awaited<ReturnType<typeof openFixture>>;
    before(async () => {
      tool = await openFixture("java-spring-boot");
    });

    const labels = (rows: Json[]) => rows.map((row) => `${row.className}.${row.name}`);
    const routes = (impact: Json) => impact.routes.map((route: Json) => `${route.framework} ${route.method} ${route.fullPath}`).sort();
    const entrypoints = (impact: Json) => impact.entrypoints.map((entry: Json) => `${entry.kind} ${entry.library} ${entry.trigger}`).sort();

    it("list_routes returns the Spring MVC routes with the class path joined", async () => {
      const result = await tool("list_routes", { framework: "spring-mvc" });
      assert.deepEqual(
        result.routes.map((route: Json) => `${route.framework} ${route.method} ${route.fullPath} ${route.handler}`),
        ["spring-mvc GET /api/orders/{id} get", "spring-mvc POST /api/orders create"],
      );
    });

    it("list_entrypoints returns main, the Spring Boot application, the scheduler and the Kafka listener", async () => {
      const result = await tool("list_entrypoints");
      assert.deepEqual(
        result.entrypoints.map((entry: Json) => `${entry.kind} ${entry.library} ${entry.trigger} ${entry.handler}`).sort(),
        [
          "main java null main",
          "queue spring-kafka orders.placed onPlaced",
          "scheduler spring cron=0 0 * * * * expire",
          "spring-boot-application spring-boot com.acme.shop.ShopApplication main",
        ],
      );
    });

    it("impact_of the implementation's save reaches the POST route and the Kafka listener through the injected service", async () => {
      const impact = await tool("impact_of", { symbol: "save", file: "JdbcOrderRepository.java" });
      assert.deepEqual(labels(impact.seeds), ["JdbcOrderRepository.save"]);
      assert.deepEqual(labels(impact.callers).sort(), ["OrderController.create", "OrderEvents.onPlaced", "OrderService.place"]);
      assert.deepEqual(routes(impact), ["spring-mvc POST /api/orders"]);
      assert.deepEqual(entrypoints(impact), ["queue spring-kafka orders.placed"]);
    });

    it("impact_of the implementation's purge reaches the scheduled job", async () => {
      const impact = await tool("impact_of", { symbol: "purge", file: "JdbcOrderRepository.java" });
      assert.deepEqual(labels(impact.callers), ["OrderService.expireStale", "StaleOrderJob.expire"]);
      assert.deepEqual(routes(impact), []);
      assert.deepEqual(entrypoints(impact), ["scheduler spring cron=0 0 * * * *"]);
    });

    it("impact_of the repository interface's methods reports the same routes and entrypoints", async () => {
      const save = await tool("impact_of", { symbol: "save", file: "OrderRepository.java" });
      assert.deepEqual(labels(save.seeds), ["OrderRepository.save"]);
      assert.deepEqual(routes(save), ["spring-mvc POST /api/orders"]);
      assert.deepEqual(entrypoints(save), ["queue spring-kafka orders.placed"]);
      const load = await tool("impact_of", { symbol: "load", file: "OrderRepository.java" });
      assert.deepEqual(routes(load), ["spring-mvc GET /api/orders/{id}"]);
      assert.deepEqual(entrypoints(load), []);
      const purge = await tool("impact_of", { symbol: "purge", file: "OrderRepository.java" });
      assert.deepEqual(entrypoints(purge), ["scheduler spring cron=0 0 * * * *"]);
      // The name alone seeds the interface method and its implementation.
      const both = await tool("impact_of", { symbol: "load" });
      assert.deepEqual(labels(both.seeds).sort(), ["JdbcOrderRepository.load", "OrderRepository.load"]);
    });
  });

  it("list_routes returns JAX-RS and Micronaut routes with their frameworks", async () => {
    const jaxrs = await openFixture("java-jaxrs");
    const rest = await jaxrs("list_routes", { framework: "jaxrs", limit: 100 });
    assert.ok(rest.routes.length >= 8);
    assert.ok(rest.routes.every((route: Json) => route.framework === "jaxrs"));
    assert.ok(rest.routes.some((route: Json) => route.method === "GET" && route.fullPath === "/users/{id}" && route.handler === "get"));

    const micronaut = await openFixture("java-micronaut");
    const routes = await micronaut("list_routes", { framework: "micronaut", limit: 100 });
    assert.ok(routes.routes.length > 0);
    assert.ok(routes.routes.every((route: Json) => route.framework === "micronaut"));
    assert.ok(routes.routes.some((route: Json) => route.method === "GET" && route.fullPath === "/users/{id}"));
    // A Micronaut @Controller is never read as Spring's.
    assert.equal((await micronaut("list_routes", { framework: "spring-mvc" })).routes.length, 0);
  });

  it("list_entrypoints returns the gRPC methods", async () => {
    const grpc = await openFixture("java-grpc");
    const result = await grpc("list_entrypoints", { kind: "grpc", limit: 100 });
    const triggers = result.entrypoints.map((entry: Json) => `${entry.library} ${entry.trigger} ${entry.handler}`).sort();
    assert.ok(triggers.includes("grpc-java User/get get"));
    assert.ok(triggers.includes("grpc-java Billing/charge charge"));
    assert.equal(triggers.length, 8);
  });
});
