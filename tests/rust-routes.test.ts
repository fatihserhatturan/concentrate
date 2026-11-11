import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

function functionName(graph: Graph, id: string): string {
  return String(graph.nodes.find((node) => node.id === id)?.properties.name);
}

// [method, fullPath, file:line, handler, lifecycle steps in order]
function routes(graph: Graph): Array<[string, string | null, string, string | null, string[]]> {
  return graph.nodes
    .filter((node) => node.label === "Route")
    .map((route) => {
      const file = graph.relationships.find((rel) => rel.type === "DECLARES_ROUTE" && rel.to === route.id)!.from.slice("file:".length);
      const handler = graph.relationships.find((rel) => rel.type === "ROUTE_HANDLED_BY" && rel.from === route.id);
      const steps = graph.relationships
        .filter((rel) => rel.type === "ROUTE_LIFECYCLE_STEP" && rel.from === route.id)
        .sort((a, b) => Number(a.properties.orderIndex) - Number(b.properties.orderIndex))
        .map((rel) => functionName(graph, rel.to));
      return [String(route.properties.method), route.properties.fullPath as string | null, `${file}:${route.properties.line}`, handler ? functionName(graph, handler.to) : String(route.properties.handlerName), steps] as [string, string | null, string, string | null, string[]];
    })
    .sort((a, b) => a[2].localeCompare(b[2], "en", { numeric: true }) || a[0].localeCompare(b[0]));
}

const scan = (fixture: string) => buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: false });

describe("Rust axum routes", () => {
  it("joins nest and merge paths across functions, modules and keeps layer order", async () => {
    const graph = await scan("rust-axum");
    assert.deepEqual(routes(graph), [
      ["GET", "/api/status", "src/api/mod.rs:9", "status", ["log_requests", "status"]],
      ["GET", "/about", "src/api/public.rs:4", "about", ["log_requests", "about"]],
      ["GET", "/api/users", "src/api/users.rs:11", "list_users", ["log_requests", "list_users"]],
      ["POST", "/api/users", "src/api/users.rs:11", "create_user", ["log_requests", "create_user"]],
      ["GET", "/api/users/:id", "src/api/users.rs:12", "show_user", ["log_requests", "show_user"]],
      ["DELETE", "/api/users/:id", "src/api/users.rs:12", "delete_user", ["log_requests", "delete_user"]],
      // A router no function mounts is a root of its own.
      ["POST", "/dead", "src/api/users.rs:40", "create_user", ["create_user"]],
      ["GET", "/admin/stats", "src/main.rs:16", "stats", ["log_requests", "require_admin", "stats"]],
      ["GET", "/health", "src/main.rs:18", "health", ["log_requests", "health"]],
    ]);
  });

  it("records extractors and reports computed paths as dynamic", async () => {
    const graph = await scan("rust-axum");
    const list = graph.nodes.find((node) => node.label === "Route" && node.properties.fullPath === "/api/users" && node.properties.method === "GET")!;
    assert.deepEqual(JSON.parse(String(list.properties.extractors)), [{ kind: "state", type: "State<AppState>" }, { kind: "query", type: "Query<ListParams>" }]);
    assert.deepEqual(JSON.parse(String(list.properties.layers)), ["mw::from_fn(middleware::log_requests)"]);
    const file = graph.nodes.find((node) => node.id === "file:src/api/public.rs")!;
    assert.equal(JSON.parse(String(file.properties.dynamicRouteCalls)).length, 1);
    assert.equal(graph.nodes.filter((node) => node.label === "Route" && String(node.properties.path).includes("terms")).length, 0);
  });
});

describe("Rust actix-web routes", () => {
  it("reads attribute routes through scopes, resources and configure", async () => {
    const graph = await scan("rust-actix");
    assert.deepEqual(routes(graph), [
      ["GET", "/health", "src/main.rs:6", "health", ["health"]],
      ["POST", "/echo", "src/main.rs:19", "echo", ["echo"]],
      ["GET", "/version", "src/main.rs:20", "version", ["version"]],
      ["GET", "/api/users", "src/users.rs:4", "list", ["list"]],
      ["POST", "/api/users", "src/users.rs:9", "create", ["create"]],
      ["GET", "/api/v2/users/{id}", "src/users.rs:15", "show", ["show"]],
      ["HEAD", "/api/v2/users/{id}", "src/users.rs:15", "show", ["show"]],
    ]);
  });
});

describe("Rust Rocket routes", () => {
  it("mounts routes![] lists, also from a function returning them", async () => {
    const graph = await scan("rust-rocket");
    assert.deepEqual(routes(graph), [
      ["GET", "/", "src/main.rs:9", "index", ["index"]],
      ["GET", "/health", "src/main.rs:14", "health", ["health"]],
      ["GET", "/posts", "src/posts.rs:7", "list", ["list"]],
      ["GET", "/posts/<id>", "src/posts.rs:13", "show", ["show"]],
      ["POST", "/posts", "src/posts.rs:18", "create", ["create"]],
    ]);
  });
});

describe("Rust warp routes", () => {
  it("reads path! and filter chains", async () => {
    const graph = await scan("rust-warp");
    assert.deepEqual(routes(graph), [
      ["GET", "/api/users", "src/main.rs:7", "list_users", ["list_users"]],
      ["GET", "/api/users/:u32", "src/main.rs:10", "show_user", ["show_user"]],
      ["POST", "/api/users", "src/main.rs:14", "create_user", ["create_user"]],
      ["GET", "/health", "src/main.rs:21", "<closure>", []],
    ]);
  });
});
