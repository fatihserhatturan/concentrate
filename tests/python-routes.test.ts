import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { cleanRegexPath, joinPaths } from "../src/integrations/frameworks/python/routes.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };
type Row = [string, string | null, string, string | null, string[]];

function functionName(graph: Graph, id: string): string {
  return String(graph.nodes.find((node) => node.id === id)?.properties.name);
}

// [method, fullPath, file:line, handler, lifecycle steps in order]
function routes(graph: Graph): Row[] {
  return graph.nodes
    .filter((node) => node.label === "Route")
    .map((route) => {
      const file = graph.relationships.find((rel) => rel.type === "DECLARES_ROUTE" && rel.to === route.id)!.from.slice("file:".length);
      const handler = graph.relationships.find((rel) => rel.type === "ROUTE_HANDLED_BY" && rel.from === route.id);
      const steps = graph.relationships
        .filter((rel) => rel.type === "ROUTE_LIFECYCLE_STEP" && rel.from === route.id)
        .sort((a, b) => Number(a.properties.orderIndex) - Number(b.properties.orderIndex))
        .map((rel) => functionName(graph, rel.to));
      return [String(route.properties.method), route.properties.fullPath as string | null, `${file}:${route.properties.line}`, handler ? functionName(graph, handler.to) : String(route.properties.handlerName), steps] as Row;
    })
    .sort((a, b) => a[2].localeCompare(b[2], "en", { numeric: true }) || a[0].localeCompare(b[0]) || String(a[1]).localeCompare(String(b[1])));
}

function entrypoints(graph: Graph): Array<[string, string, string, string | null]> {
  return graph.nodes
    .filter((node) => node.label === "EntryPoint" && node.properties.library !== "python")
    .map((entry) => {
      const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id);
      return [String(entry.properties.kind), String(entry.properties.library), String(entry.properties.trigger), handler ? functionName(graph, handler.to) : null] as [string, string, string, string | null];
    })
    .sort((a, b) => a.join("\0").localeCompare(b.join("\0"), "en"));
}

const scan = (fixture: string) => buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: false });

describe("Python Flask routes", () => {
  it("joins blueprint prefixes (own, replaced by register_blueprint, nested), keeps one route per mount and runs hooks first", async () => {
    const graph = await scan("python-flask");
    assert.deepEqual(routes(graph), [
      ["GET","/","app/__init__.py:17","index",["load_user","index"]],
      ["DELETE","/api/users/<int:user_id>","app/api.py:16","user",["load_user","check_token","user"]],
      ["DELETE","/v2/users/<int:user_id>","app/api.py:16","user",["load_user","check_token","user"]],
      ["GET","/api/users/<int:user_id>","app/api.py:16","user",["load_user","check_token","user"]],
      ["GET","/v2/users/<int:user_id>","app/api.py:16","user",["load_user","check_token","user"]],
      ["GET","/api/items","app/api.py:29","get",["load_user","check_token","get"]],
      ["GET","/v2/items","app/api.py:29","get",["load_user","check_token","get"]],
      ["POST","/api/items","app/api.py:29","post",["load_user","check_token","post"]],
      ["POST","/v2/items","app/api.py:29","post",["load_user","check_token","post"]],
      ["GET","/api/admin/stats","app/api.py:32","stats",["load_user","check_token","stats"]],
      ["GET","/v2/admin/stats","app/api.py:32","stats",["load_user","check_token","stats"]],
      ["GET","/api/health","app/api.py:42","get",["load_user","check_token","get"]],
      ["GET","/v2/health","app/api.py:42","get",["load_user","check_token","get"]],
      ["GET","/auth/login","app/auth.py:6","login",["load_user","login"]],
      ["POST","/auth/login","app/auth.py:6","login",["load_user","login"]],
      ["GET","/auth/logout","app/auth.py:11","logout",["load_user","logout"]],
    ]);
  });

  it("matches what Flask registers: the same url_map as a real app", async () => {
    const graph = await scan("python-flask");
    const paths = routes(graph).map(([method, fullPath]) => `${method} ${fullPath}`);
    // `Blueprint.register_blueprint(url_prefix=..)` replaces the blueprint's own prefix; a child blueprint is below its parent's.
    assert.ok(paths.includes("GET /api/admin/stats") && paths.includes("GET /v2/admin/stats"));
    assert.ok(!paths.some((entry) => entry.includes("/api/v2")));
    const restful = graph.nodes.filter((node) => node.label === "Route" && node.properties.framework === "flask-restful");
    assert.deepEqual(restful.map((node) => node.properties.fullPath).sort(), ["/api/health", "/v2/health"]);
  });
});

describe("Python FastAPI routes", () => {
  it("composes include_router prefixes and runs app, include and route dependencies (nested ones first) before the handler", async () => {
    const graph = await scan("python-fastapi");
    assert.deepEqual(routes(graph), [
      ["GET","/health","app/main.py:11","health",["verify_key","health"]],
      ["GET","/ping","app/main.py:20","ping",["verify_key","ping"]],
      ["GET","/v1/items/{item_id}","app/routers/items.py:6","read_item",["verify_key","rate_limit","read_item"]],
      ["WS","/v1/items/ws","app/routers/items.py:11","items_ws",["verify_key","rate_limit","items_ws"]],
      ["GET","/api/v1/users/","app/routers/users.py:10","list_users",["verify_key","get_db","list_users"]],
      ["POST","/api/v1/users/","app/routers/users.py:15","create_user",["verify_key","get_db","require_admin","create_user"]],
      ["GET","/api/v1/users/{user_id}","app/routers/users.py:20","read_user",["verify_key","get_db","current_user","read_user"]],
    ]);
  });

  it("records the request parameters of a handler and the dependencies as written", async () => {
    const graph = await scan("python-fastapi");
    const list = graph.nodes.find((node) => node.label === "Route" && node.properties.fullPath === "/api/v1/users/" && node.properties.method === "GET")!;
    assert.deepEqual(JSON.parse(String(list.properties.extractors)), [{ kind: "query", name: "q", type: "str" }]);
    assert.deepEqual(JSON.parse(String(list.properties.layers)), ["Depends(verify_key)", "Depends(get_db)"]);
    const steps = graph.relationships.filter((rel) => rel.type === "ROUTE_LIFECYCLE_STEP" && rel.from === list.id).sort((a, b) => Number(a.properties.orderIndex) - Number(b.properties.orderIndex));
    assert.deepEqual(steps.map((rel) => [rel.properties.role, rel.properties.scope]), [["dependency", "app"], ["dependency", "route"], ["handler", "route"]]);
  });
});

describe("Python Starlette routes", () => {
  it("reads Route, Mount and WebSocketRoute lists across files and class endpoints", async () => {
    const graph = await scan("python-starlette");
    assert.deepEqual(routes(graph), [
      ["GET","/api/items","api_routes.py:14","items",["items"]],
      ["POST","/api/items","api_routes.py:14","items",["items"]],
      ["GET","/api/items/{id:int}","api_routes.py:15","item",["item"]],
      ["GET","/","app.py:27","homepage",["homepage"]],
      ["DELETE","/users/{name}","app.py:28","delete",["delete"]],
      ["GET","/users/{name}","app.py:28","get",["get"]],
      ["WS","/ws","app.py:31","ws",["ws"]],
    ]);
  });
});

describe("Python Django routes", () => {
  it("composes include() (strings, modules, routers), as_view, @api_view, router actions and MIDDLEWARE", async () => {
    const graph = await scan("python-django");
    assert.deepEqual(routes(graph), [
      ["ALL","/blog/<slug:slug>/","blog/urls.py:6","post_detail",["__call__","timing_middleware","post_detail"]],
      ["GET","/blog/","blog/urls.py:7","views.PostList",["__call__","timing_middleware"]],
      ["DELETE","/api/products/<pk>/","catalog/urls.py:7","views.ProductViewSet.destroy",["__call__","timing_middleware"]],
      ["GET","/api/products/","catalog/urls.py:7","list",["__call__","timing_middleware","list"]],
      ["GET","/api/products/<pk>/","catalog/urls.py:7","views.ProductViewSet.retrieve",["__call__","timing_middleware"]],
      ["GET","/api/products/recent/","catalog/urls.py:7","recent",["__call__","timing_middleware","recent"]],
      ["PATCH","/api/products/<pk>/","catalog/urls.py:7","views.ProductViewSet.partial_update",["__call__","timing_middleware"]],
      ["POST","/api/products/","catalog/urls.py:7","views.ProductViewSet.create",["__call__","timing_middleware"]],
      ["POST","/api/products/<pk>/publish/","catalog/urls.py:7","publish",["__call__","timing_middleware","publish"]],
      ["PUT","/api/products/<pk>/","catalog/urls.py:7","views.ProductViewSet.update",["__call__","timing_middleware"]],
      ["GET","/api/health/","catalog/urls.py:10","health",["__call__","timing_middleware","health"]],
      ["DELETE","/api/items/<int:pk>/","catalog/urls.py:11","delete",["__call__","timing_middleware","delete"]],
      ["GET","/api/items/<int:pk>/","catalog/urls.py:11","get",["__call__","timing_middleware","get"]],
      ["PUT","/api/items/<int:pk>/","catalog/urls.py:11","put",["__call__","timing_middleware","put"]],
      ["ALL","/","shop/urls.py:10","home",["__call__","timing_middleware","home"]],
      ["GET","/legacy/<year>/","shop/urls.py:13","legacy",["__call__","timing_middleware","legacy"]],
      ["POST","/legacy/<year>/","shop/urls.py:13","legacy",["__call__","timing_middleware","legacy"]],
      ["GET","/about/","shop/urls.py:14","views.AboutView",["__call__","timing_middleware"]],
    ]);
  });

  it("marks Django REST framework routes and the generic views' methods", async () => {
    const graph = await scan("python-django");
    const frameworks = new Map(graph.nodes.filter((node) => node.label === "Route").map((node) => [`${node.properties.method} ${node.properties.fullPath}`, node.properties.framework]));
    assert.equal(frameworks.get("GET /api/products/"), "django-rest-framework");
    assert.equal(frameworks.get("GET /about/"), "django");
    assert.equal(frameworks.get("GET /blog/"), "django");
    assert.equal(frameworks.has("POST /about/"), false);
    const home = graph.nodes.find((node) => node.label === "Route" && node.properties.fullPath === "/" && node.properties.method === "ALL")!;
    assert.deepEqual(JSON.parse(String(home.properties.layers)), ["django.middleware.security.SecurityMiddleware", "shop.middleware.AuditMiddleware", "shop.middleware.timing_middleware"]);
  });
});

describe("Python entrypoints", () => {
  it("finds Celery tasks, click and typer commands, Flask CLI and Django management commands", async () => {
    const commands = entrypoints(await scan("python-commands"));
    assert.deepEqual(commands, [
      ["cli", "click", "cli", "cli"],
      ["cli", "click", "db migrate", "migrate_db"],
      ["cli", "click", "db", "db"],
      ["cli", "click", "run-server", "run_server_command"],
      ["cli", "click", "solo", "standalone"],
      ["cli", "flask", "seed", "seed"],
      ["cli", "typer", "hello-world", "hello_world"],
      ["cli", "typer", "users create", "create_user"],
      ["queue", "celery", "reports.build", "build_report"],
      ["queue", "celery", "tasks.send_email", "send_email"],
    ]);
    assert.deepEqual(entrypoints(await scan("python-django")), [["cli", "django", "seed", "handle"]]);
  });

  it("links .delay, .apply_async, .s and send_task to the task", async () => {
    const graph = await scan("python-commands");
    const links = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.properties.via === "celery")
      .map((rel) => `${graph.nodes.find((node) => node.id === rel.from)!.properties.expression}->${functionName(graph, rel.to)}`)
      .sort();
    assert.deepEqual(links, ["app.send_task->build_report", "build_report.apply_async->build_report", "send_email.delay->send_email", "tasks.send_email.s->send_email"]);
  });
});

describe("Python path helpers", () => {
  it("writes a re_path regex as a path", () => {
    assert.equal(cleanRegexPath("^articles/(?P<year>[0-9]{4})/$"), "articles/<year>/");
    assert.equal(cleanRegexPath("^user/?$"), "user");
    assert.equal(cleanRegexPath("^a/(\\d+)/b\\.json$"), "a/<arg>/b.json");
    assert.equal(cleanRegexPath("^"), "");
  });

  it("joins Django prefixes by concatenation and the others as paths", () => {
    assert.equal(joinPaths(["api/", "users/"], "django"), "/api/users/");
    assert.equal(joinPaths(["", ""], "django"), "/");
    assert.equal(joinPaths(["/api", "/users", "/"], "slash"), "/api/users/");
    assert.equal(joinPaths(["/items", ""], "slash"), "/items");
    assert.equal(joinPaths(["", "x"], "slash"), "/x");
  });
});

describe("Python routes over MCP", () => {
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    const graph = await scan("python-fastapi");
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-python-routes-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("answers list_routes, route_details and impact_of for a FastAPI service", async () => {
    const listed = await tool("list_routes", { framework: "fastapi" });
    assert.deepEqual(listed.routes.map((route: any) => `${route.method} ${route.fullPath}`).sort(), [
      "GET /api/v1/users/", "GET /api/v1/users/{user_id}", "GET /health", "GET /ping", "GET /v1/items/{item_id}", "POST /api/v1/users/", "WS /v1/items/ws",
    ]);
    const details = await tool("route_details", { method: "post", path: "/api/v1/users/" });
    assert.deepEqual(details.routes[0].handlers.map((handler: any) => handler.name), ["create_user"]);
    assert.deepEqual(details.routes[0].lifecycle.map((step: any) => [step.role, step.name]), [
      ["dependency", "verify_key"], ["dependency", "get_db"], ["dependency", "require_admin"], ["handler", "create_user"],
    ]);
    const impact = await tool("impact_of", { symbol: "get_db" });
    assert.equal(impact.routes.length, 3);
  });
});
