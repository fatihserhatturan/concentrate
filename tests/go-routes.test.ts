import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { joinRoutePaths, parseServeMuxPattern } from "../src/integrations/frameworks/go/routes.js";

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
      return [String(route.properties.method), route.properties.fullPath as string | null, `${file}:${route.properties.line}`, handler ? functionName(graph, handler.to) : null, steps] as [string, string | null, string, string | null, string[]];
    })
    .sort((a, b) => a[2].localeCompare(b[2], "en", { numeric: true }) || a[0].localeCompare(b[0]));
}

describe("Go gin routes", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-gin"), { continueOnError: false });
  });

  it("joins group paths across functions and keeps gin's middleware order", () => {
    assert.deepEqual(routes(graph), [
      ["GET", "/health", "main.go:28", "ping", ["Logger", "ping"]],
      ["OPTIONS", "/ping", "main.go:29", "ping", ["Logger", "ping"]],
      ["ALL", "/echo", "main.go:30", "ping", ["Logger", "ping"]],
      ["GET", "/api/v1/items", "main.go:34", "List", ["Logger", "List"]],
      // Use applies to what is registered after it.
      ["POST", "/api/v1/items", "main.go:38", "<v1.POST:/items:arg1>", ["Logger", "Required", "<v1.POST:/items:arg1>"]],
      // `r.Group("/admin").Use(auth.Required(true))`: gin's Use returns the group.
      ["GET", "/admin/stats", "main.go:44", "ping", ["Logger", "Required", "ping"]],
      ["GET", "/api/v1/users", "routes/users.go:14", "Show", ["Logger", "Show"]],
      ["GET", "/api/v1/users/:id", "routes/users.go:15", "Show", ["Logger", "Show"]],
      ["POST", "/api/v1/users/", "routes/users.go:17", "Create", ["Logger", "Required", "Audit", "Create"]],
      ["DELETE", "/api/v1/users/admin/:id", "routes/users.go:22", "Create", ["Logger", "Required", "Create"]],
    ]);
  });

  it("keeps a factory middleware's call on its lifecycle step", () => {
    const steps = (method: string, fullPath: string) => {
      const route = graph.nodes.find((node) => node.label === "Route" && node.properties.method === method && node.properties.fullPath === fullPath)!;
      return graph.relationships
        .filter((rel) => rel.type === "ROUTE_LIFECYCLE_STEP" && rel.from === route.id)
        .sort((a, b) => Number(a.properties.orderIndex) - Number(b.properties.orderIndex))
        .map((rel) => [functionName(graph, rel.to), rel.properties.expression ?? null]);
    };
    assert.deepEqual(steps("POST", "/api/v1/items"), [["Logger", null], ["Required", "auth.Required(true)"], ["<v1.POST:/items:arg1>", null]]);
    assert.deepEqual(steps("POST", "/api/v1/users/"), [["Logger", null], ["Required", "auth.Required(false)"], ["Audit", null], ["Create", null]]);
  });

  it("moves a closure handler's calls to a function of its own", () => {
    const closure = graph.nodes.find((node) => node.label === "Function" && node.properties.name === "<v1.POST:/items:arg1>")!;
    assert.equal(closure.properties.kind, "func_literal");
    const calls = graph.relationships.filter((rel) => rel.type === "CALLS" && rel.from === closure.id);
    assert.deepEqual(calls.map((rel) => graph.nodes.find((node) => node.id === rel.to)?.properties.name), ["ping"]);
  });

  it("lists a registration with a computed path as dynamic", () => {
    const main = graph.nodes.find((node) => node.id === "file:main.go")!;
    assert.deepEqual(JSON.parse(String(main.properties.dynamicRouteCalls)), [{ line: 50, expression: "r.GET", framework: "gin" }]);
  });

  it("leaves no pending properties behind", () => {
    assert.ok(graph.nodes.every((node) => node.properties.goPending === undefined && node.properties.routerArguments === undefined));
  });
});

describe("Go net/http routes", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-nethttp"), { continueOnError: false });
  });

  it("reads ServeMux patterns, StripPrefix mounts, the default mux and wrapped handlers", () => {
    assert.deepEqual(routes(graph), [
      ["ALL", "/metrics", "main.go:18", "metrics", ["metrics"]],
      ["DELETE", "/admin/cache", "main.go:36", "clearCache", ["clearCache"]],
      ["GET", "/items/{id}", "main.go:41", "getItem", ["getItem"]],
      // http.FileServer is not the project's.
      ["ALL", "/static/", "main.go:42", null, []],
      ["ALL", "/secure", "main.go:43", "secure", ["withAuth", "secure"]],
      ["POST", "/api/orders", "main.go:47", "create", ["create"]],
      ["ALL", "/health", "main.go:53", "health", ["health"]],
      // A mux another function returns, mounted below a stripped prefix.
      ["GET", "/v2/ping", "main.go:60", "health", ["health"]],
    ]);
    assert.ok(graph.nodes.filter((node) => node.label === "Route").every((node) => node.properties.framework === "net/http"));
  });

  it("parses Go 1.22 patterns and joins paths like gin", () => {
    assert.deepEqual(parseServeMuxPattern("GET /items/{id}"), { method: "GET", path: "/items/{id}" });
    assert.deepEqual(parseServeMuxPattern("example.com/x/"), { method: "ALL", path: "/x/" });
    assert.deepEqual(parseServeMuxPattern("/"), { method: "ALL", path: "/" });
    assert.equal(joinRoutePaths("/api", ""), "/api");
    assert.equal(joinRoutePaths("/api", "/"), "/api/");
    assert.equal(joinRoutePaths("", ""), "/");
    assert.equal(joinRoutePaths("/api/", "/x/"), "/api/x/");
  });
});

async function scan(fixture: string): Promise<Graph> {
  return buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: false });
}

describe("Go echo, chi, fiber, gorilla/mux and routegroup routes", () => {
  it("echo: the handler first, the root's Use for every route, a group's for what follows", async () => {
    assert.deepEqual(routes(await scan("go-echo")), [
      ["GET", "/health", "main.go:28", "list", ["auth", "list"]],
      ["GET", "/api/users", "main.go:34", "list", ["auth", "audit", "list"]],
      ["POST", "/api/users", "main.go:35", "show", ["auth", "audit", "audit", "show"]],
      ["PATCH", "/api/users/:id", "main.go:36", "show", ["auth", "audit", "show"]],
      ["PUT", "/api/users/:id", "main.go:36", "show", ["auth", "audit", "show"]],
      ["DELETE", "/cache", "main.go:39", "show", ["auth", "show"]],
      ["GET", "/api/admin/stats", "main.go:45", "list", ["auth", "audit", "auth", "list"]],
    ]);
  });

  it("chi: Route and Group callbacks, With, Mount of a returned router and a named callback", async () => {
    assert.deepEqual(routes(await scan("go-chi")), [
      ["GET", "/", "main.go:21", "list", ["list"]],
      ["GET", "/articles", "main.go:24", "list", ["list"]],
      ["POST", "/articles", "main.go:25", "show", ["auth", "show"]],
      ["GET", "/articles/{id}", "main.go:27", "show", ["show"]],
      ["DELETE", "/cache", "main.go:33", "show", ["auth", "show"]],
      ["PATCH", "/x", "main.go:38", "show", ["show"]],
      // A dependency's handler mounted as is.
      ["ALL", "/debug", "main.go:39", null, []],
      ["GET", "/admin/stats", "main.go:47", "list", ["auth", "list"]],
      ["GET", "/users/{name}", "main.go:52", "show", ["show"]],
    ]);
  });

  it("fiber: groups with handlers, Route, Add, All and a mounted app", async () => {
    assert.deepEqual(routes(await scan("go-fiber")), [
      ["GET", "/", "main.go:20", "list", ["auth", "list"]],
      ["GET", "/api/items", "main.go:23", "list", ["auth", "auth", "list"]],
      ["POST", "/api/items", "main.go:24", "show", ["auth", "auth", "auth", "show"]],
      ["GET", "/v2/items", "main.go:27", "show", ["auth", "show"]],
      ["PUT", "/items/:id", "main.go:30", "show", ["auth", "show"]],
      ["ALL", "/any", "main.go:31", "list", ["auth", "list"]],
      ["GET", "/sub/ping", "main.go:39", "list", ["auth", "list"]],
    ]);
  });

  it("gorilla/mux: Methods chains, subrouters and router-wide middleware", async () => {
    assert.deepEqual(routes(await scan("go-mux")), [
      ["ALL", "/", "main.go:23", "list", ["logging", "list"]],
      ["GET", "/items", "main.go:24", "list", ["logging", "list"]],
      ["PATCH", "/items/{id}", "main.go:25", "show", ["logging", "show"]],
      ["PUT", "/items/{id}", "main.go:25", "show", ["logging", "show"]],
      ["GET", "/api/users", "main.go:29", "list", ["logging", "auth", "list"]],
      ["ALL", "/static/", "main.go:31", null, ["logging"]],
    ]);
  });

  it("routegroup: Mount prefixes, Route on the root and on a group, With and HandleRoot", async () => {
    assert.deepEqual(routes(await scan("go-routegroup")), [
      ["GET", "/health", "main.go:24", "list", ["logging", "list"]],
      ["GET", "/api/v1/items", "main.go:27", "list", ["logging", "list"]],
      ["POST", "/api/v1/items", "main.go:28", "show", ["logging", "auth", "show"]],
      ["DELETE", "/api/v1/admin/cache", "main.go:32", "show", ["logging", "auth", "show"]],
      // HandleRoot registers the bundle's own path.
      ["GET", "/api/v1/admin", "main.go:33", "list", ["logging", "auth", "list"]],
      // Route on the root configures a new group, so its Use stays there.
      ["PUT", "/private", "main.go:38", "show", ["logging", "auth", "show"]],
      ["ALL", "/v2/files/", "main.go:42", null, []],
    ]);
  });
});

describe("route MCP tools on Go", () => {
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/go-gin"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-go-routes-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("list_routes, route_details and impact_of work on gin routes", async () => {
    const listed = await tool("list_routes", { framework: "gin" });
    assert.equal(listed.routes.length, 10);
    assert.deepEqual(listed.dynamicRouteCalls, [{ file: "main.go", line: 50, expression: "r.GET", framework: "gin" }]);

    const details = await tool("route_details", { method: "post", path: "/api/v1/users/" });
    assert.equal(details.routes.length, 1);
    assert.deepEqual(details.routes[0].lifecycle.map((step: any) => [step.role, step.name]), [
      ["middleware", "Logger"],
      ["middleware", "Required"],
      ["middleware", "Audit"],
      ["handler", "Create"],
    ]);

    const impact = await tool("impact_of", { symbol: "Show" });
    assert.deepEqual(impact.routes.map((route: any) => route.fullPath).sort(), ["/api/v1/users", "/api/v1/users/:id"]);
  });
});

// [kind, trigger, file:line, handler, calls the handler makes]
function entrypoints(graph: Graph): Array<[string, string | null, string, string | null, number]> {
  return graph.nodes
    .filter((node) => node.label === "EntryPoint")
    .map((entrypoint) => {
      const file = graph.relationships.find((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.to === entrypoint.id)!.from.slice("file:".length);
      const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entrypoint.id);
      const calls = handler ? graph.relationships.filter((rel) => rel.type === "CALLS" && rel.from === handler.to).length : 0;
      return [String(entrypoint.properties.kind), entrypoint.properties.trigger as string | null, `${file}:${entrypoint.properties.line}`, handler ? functionName(graph, handler.to) : null, calls] as [string, string | null, string, string | null, number];
    })
    .sort((a, b) => a[2].localeCompare(b[2], "en", { numeric: true }) || String(a[1]).localeCompare(String(b[1])));
}

describe("Go gRPC and cobra entrypoints", () => {
  it("a registered gRPC service's methods, promoted ones included, by the generated interface", async () => {
    const graph = await scan("go-grpc");
    assert.deepEqual(entrypoints(graph), [
      ["main", null, "main.go:12", "main", 5],
      ["grpc", "Greeter/SayBye", "main.go:15", "SayBye", 0],
      ["grpc", "Greeter/SayHello", "main.go:15", "SayHello", 0],
    ]);
    const sayBye = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from.endsWith("grpc:Greeter/SayBye"))!;
    assert.equal(graph.nodes.find((node) => node.id === sayBye.to)?.properties.className, "UnimplementedGreeterServer");
    assert.ok(graph.nodes.every((node) => node.properties.grpcRegistration === undefined));
  });

  it("cobra commands with their full path and Run / RunE handler", async () => {
    const graph = await scan("go-cobra");
    assert.deepEqual(entrypoints(graph), [
      ["init", null, "cmd/root.go:20", "init", 2],
      ["cli", "app serve", "cmd/serve.go:9", "runServe", 0],
      ["cli", "app version", "cmd/serve.go:14", "<versionCmd.Run>", 1],
      ["cli", "app serve migrate", "cmd/serve.go:30", "<cmd.RunE>", 1],
      ["main", null, "main.go:5", "main", 1],
    ]);
    assert.ok(graph.nodes.every((node) => node.properties.goPending === undefined && node.properties.goCommandTree === undefined));
  });
});

describe("list_entrypoints on Go", () => {
  const listed = async (fixture: string, kind: string) => {
    const store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-go-entrypoints-")), "graph"));
    try {
      await store.reset();
      const graph = await scan(fixture);
      await store.write(graph.nodes, graph.relationships);
      return ((await callMcpTool(store, "list_entrypoints", { kind })).structuredContent as Record<string, any>).entrypoints;
    } finally {
      await store.close();
    }
  };

  it("filters cobra commands and gRPC methods by kind", async () => {
    assert.deepEqual((await listed("go-cobra", "cli")).map((entry: any) => [entry.trigger, entry.library, entry.handler]), [
      ["app serve", "cobra", "runServe"],
      ["app version", "cobra", "<versionCmd.Run>"],
      ["app serve migrate", "cobra", "<cmd.RunE>"],
    ]);
    assert.deepEqual((await listed("go-grpc", "grpc")).map((entry: any) => entry.trigger), ["Greeter/SayBye", "Greeter/SayHello"]);
  });
});
