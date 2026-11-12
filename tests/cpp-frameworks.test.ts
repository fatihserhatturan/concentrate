import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { findInvocations, readCppSource, resolveString, scopeAt, scopesOf, stringConstants, stringLiteral, stringValue } from "../src/integrations/frameworks/cpp/scan.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const scan = (directory: string): Promise<Graph> => buildCodeGraph(path.resolve(directory), { continueOnError: false });
const strip = (id: string) => id.replace(/^file:/u, "");

function label(graph: Graph, id: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) return id;
  if (node.label === "Function") return `${node.properties.className ? `${node.properties.className}.` : ""}${node.properties.name}`;
  if (node.label === "Route") return `${node.properties.method} ${node.properties.fullPath}`;
  return String(node.properties.name ?? node.id);
}

function routes(graph: Graph): string[] {
  const handled = new Map(graph.relationships.filter((rel) => rel.type === "ROUTE_HANDLED_BY").map((rel) => [rel.from, rel.to]));
  return graph.nodes.filter((node) => node.label === "Route").map((node) => {
    const handler = handled.get(node.id);
    return `${node.properties.framework} ${node.properties.method} ${node.properties.fullPath ?? node.properties.pathExpression} @${strip(node.id.split(":route:")[0]!)}:${node.properties.line} -> ${handler ? label(graph, handler) : node.properties.handlerName ?? "-"}`;
  }).sort();
}

describe("C and C++ source reader", () => {
  it("blanks comments and string contents for finding calls, and keeps raw strings whole", () => {
    const source = readCppSource(`// svr.Get("/a", h);
/* svr.Get("/b", h); */
svr.Get(R"(/numbers/(\\d+))", [&](auto &req, auto &res) { f("x)"); });
#define ROUTE(m) svr.Get("/macro", m)
svr.Post("/c", h); // tail
`);
    const calls = findInvocations(source, "Get|Post");
    assert.deepEqual(calls.map((call) => [call.name, call.receiver, call.line, call.args.length]), [["Get", "svr", 3, 2], ["Post", "svr", 5, 2]]);
    assert.equal(stringLiteral(calls[0]!.args[0]!), "/numbers/(\\d+)");
    assert.equal(source.code.length, source.text.length);
  });

  it("reads literals, constants and concatenations, and keeps unknown parts as parameters", () => {
    const source = readCppSource(`#define BASE "http://host"
static const std::string kPath = "/api";
void f(int id) {
  std::string url = BASE + kPath + "/users/" + std::to_string(id);
  call(url.c_str());
}`);
    const constants = stringConstants(source);
    assert.equal(constants.get("BASE"), "http://host");
    assert.equal(constants.get("kPath"), "/api");
    assert.equal(stringLiteral(`"a" "b\\n"`), "a" + "b\n");
    assert.equal(stringValue("std::string(kPath)", constants), "/api");
    assert.equal(stringValue("name", constants), null);
    const at = source.text.indexOf("call(");
    assert.equal(resolveString(source, "url.c_str()", at, 0, constants), "http://host/api/users/${id}");
    assert.equal(resolveString(source, "(BASE + prefix).c_str()", at, 0, constants), "http://host${prefix}");
  });

  it("finds the namespace and class around an offset", () => {
    const source = readCppSource("namespace a::b { class C : public D { void f(); }; } struct E { };");
    const scopes = scopesOf(source);
    assert.deepEqual(scopeAt(scopes, source.text.indexOf("void f")), { namespace: "a::b", className: "C" });
    assert.deepEqual(scopeAt(scopes, source.text.indexOf("{ }") + 1), { namespace: "", className: "E" });
  });
});

describe("C and C++ HTTP routes (fixtures/cpp-web)", () => {
  it("reads Crow, Drogon, Pistache and cpp-httplib routes with their handlers", async () => {
    assert.deepEqual(routes(await scan("fixtures/cpp-web")), [
      "crow GET / @src/crow_app.cpp:12 -> <lambda>",
      "crow GET /api/users/<string> @src/crow_app.cpp:18 -> <lambda>",
      "crow GET /api/status @src/crow_app.cpp:17 -> <lambda>",
      "crow GET /health @src/crow_app.cpp:13 -> health",
      "crow POST /items/<int> @src/crow_app.cpp:14 -> <lambda>",
      "crow PUT /items/<int> @src/crow_app.cpp:14 -> <lambda>",
      "drogon GET /ping @src/drogon_ctrl.h:23 -> Ping.asyncHandleHttpRequest",
      "drogon GET /api/v1/User/{1}/info @src/drogon_ctrl.h:9 -> User.getInfo",
      "drogon GET /hello @src/drogon_ctrl.cc:10 -> <lambda>",
      "drogon GET /users @src/drogon_ctrl.h:11 -> User.list",
      "drogon POST /api/v1/User @src/drogon_ctrl.h:10 -> User.create",
      "drogon POST /hello @src/drogon_ctrl.cc:10 -> <lambda>",
      "drogon POST /ping @src/drogon_ctrl.h:23 -> Ping.asyncHandleHttpRequest",
      "drogon POST /users @src/drogon_ctrl.h:11 -> User.list",
      "httplib DELETE /users/:id @src/httplib_server.cpp:23 -> getUser",
      "httplib GET /hi @src/httplib_server.cpp:20 -> <lambda>",
      "httplib GET /numbers/(\\d+) @src/httplib_server.cpp:21 -> <lambda>",
      "httplib POST /users @src/httplib_server.cpp:22 -> getUser",
      "pistache GET /records/:id @src/httplib_server.cpp:10 -> Endpoint.readRecord",
      "pistache POST /records @src/httplib_server.cpp:11 -> Endpoint.addRecord",
    ].sort());
  });

  it("ignores a macro's definition and a client call of the same name", async () => {
    const graph = await scan("fixtures/cpp-clients");
    const found = routes(graph);
    assert.equal(found.length, 4);
    assert.ok(found.every((entry) => entry.startsWith("httplib ") && entry.includes("src/server.cpp")), found.join("\n"));
  });
});

describe("gRPC C++ (fixtures/cpp-grpc)", () => {
  it("makes entrypoints of the service methods and links stub calls to them", async () => {
    const graph = await scan("fixtures/cpp-grpc");
    const entrypoints = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "grpc").map((node) => `${node.properties.trigger}@${node.properties.receiverName}`).sort();
    assert.deepEqual(entrypoints, ["Greeter/SayHello@CallbackImpl", "Greeter/SayHello@GreeterServiceImpl", "Greeter/SayHelloStreamReply@GreeterServiceImpl"]);
    const links = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.properties.via === "grpc")
      .map((rel) => `${strip(rel.from).split(":call:")[0]!.replace(/:function:.*/u, "")} ${graph.nodes.find((node) => node.id === rel.from)!.properties.expression} -> ${label(graph, rel.to)}`)
      .sort();
    assert.deepEqual(links, [
      "src/client.cc stub->SayHelloStreamReply -> GreeterServiceImpl.SayHelloStreamReply",
      "src/client.cc stub_->SayHello -> CallbackImpl.SayHello",
      "src/client.cc stub_->SayHello -> GreeterServiceImpl.SayHello",
    ]);
  });

  it("links the .proto rpcs to their implementations", async () => {
    const graph = await scan("fixtures/cpp-grpc");
    const implemented = graph.relationships.filter((rel) => rel.type === "RPC_IMPLEMENTED_BY").map((rel) => `${label(graph, rel.from)} -> ${label(graph, rel.to)}`).sort();
    assert.deepEqual(implemented, ["SayHello -> CallbackImpl.SayHello", "SayHello -> GreeterServiceImpl.SayHello", "SayHelloStreamReply -> GreeterServiceImpl.SayHelloStreamReply"]);
  });
});

describe("Qt signals and slots (fixtures/cpp-qt)", () => {
  it("links signals to slots for the pointer and string forms", async () => {
    const graph = await scan("fixtures/cpp-qt");
    const connections = graph.relationships.filter((rel) => rel.type === "SIGNAL_CONNECTS_TO").map((rel) => `${label(graph, rel.from)} -> ${label(graph, rel.to)} ${rel.properties.file}:${rel.properties.line} ${rel.properties.style}`).sort();
    assert.deepEqual(connections, [
      "Worker.finished -> Controller.onFinished src/main.cpp:20 pointer",
      "Worker.finished -> Window.quit src/main.cpp:12 string",
      "Worker.progress -> Controller.onProgress src/main.cpp:21 pointer",
    ]);
    const resolved = graph.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.properties.via === "qt").map((rel) => label(graph, rel.to)).sort();
    assert.deepEqual(resolved, ["Controller.onFinished", "Controller.onProgress", "Window.quit"]);
  });
});

describe("C and C++ data access and env (fixtures/cpp-data, fixtures/c-services)", () => {
  it("maps SQL strings of sqlite3, libpq and SOCI to tables, merging with .sql files and CREATE strings", async () => {
    const graph = await scan("fixtures/cpp-data");
    const direct = graph.relationships
      .filter((rel) => rel.type === "ACCESSES_DATA" && rel.properties.direct === true)
      .map((rel) => `${label(graph, rel.from)} ${rel.properties.library} ${rel.properties.operation} ${label(graph, rel.to)}`)
      .sort();
    assert.deepEqual(direct, [
      "addUser sqlite3 create users",
      "listUsers sqlite3 read orders",
      "listUsers sqlite3 read users",
      "main sqlite3 create users",
      "main sqlite3 read users",
      "removeOrders libpq delete orders",
      "removeOrders libpq update accounts",
      "touch soci read events",
      "touch soci update users",
    ]);
    const tables = graph.nodes.filter((node) => node.label === "Table").map((node) => `${node.properties.name}@${node.properties.declaredIn ?? "-"}`).sort();
    assert.deepEqual(tables, ["accounts@schema.sql", "events@-", "orders@schema.sql", "users@src/store.cpp"]);
    const users = graph.nodes.find((node) => node.label === "Table" && node.properties.name === "users")!;
    assert.deepEqual((JSON.parse(String(users.properties.columns)) as Array<{ name: string }>).map((column) => column.name), ["id", "name", "email"]);
  });

  it("gives the route whose lambda holds the SQL the access, and propagates to its entrypoint", async () => {
    const graph = await scan("fixtures/cpp-data");
    const byRoute = graph.relationships.filter((rel) => rel.type === "WRITES" && graph.nodes.find((node) => node.id === rel.from)?.label === "Route").map((rel) => `${label(graph, rel.from)} -> ${label(graph, rel.to)}`);
    assert.deepEqual(byRoute, ["POST /api/users -> users"]);
  });

  it("reads getenv, std::getenv and secure_getenv with constants, from functions and files", async () => {
    const graph = await scan("fixtures/cpp-data");
    const reads = graph.relationships.filter((rel) => rel.type === "USES_ENV" && graph.nodes.find((node) => node.id === rel.from)?.label === "Function")
      .map((rel) => `${label(graph, rel.from)} ${label(graph, rel.to)} ${rel.properties.access}`).sort();
    assert.deepEqual(reads, ["main APP_PORT secure_getenv", "openDatabase APP_DB_MODE getenv", "openDatabase APP_DB_PATH getenv"]);
  });

  it("reads the same in C files", async () => {
    const graph = await scan("fixtures/c-services");
    const env = graph.relationships.filter((rel) => rel.type === "USES_ENV" && graph.nodes.find((node) => node.id === rel.from)?.label === "Function").map((rel) => `${label(graph, rel.to)} ${rel.properties.access}`).sort();
    assert.deepEqual(env, ["DATABASE_URL getenv", "INGEST_TOKEN secure_getenv"]);
    const data = graph.relationships.filter((rel) => rel.type === "ACCESSES_DATA" && rel.properties.direct === true).map((rel) => `${label(graph, rel.from)} ${rel.properties.library} ${rel.properties.operation} ${label(graph, rel.to)}`).sort();
    assert.deepEqual(data, ["purge libpq delete samples", "save sqlite3 create samples"]);
    const request = graph.nodes.find((node) => node.label === "Call" && node.properties.httpClient === "libcurl")!;
    assert.deepEqual([request.properties.httpMethod, request.properties.httpUrl], ["POST", "/ingest"]);
  });
});

describe("C and C++ outbound HTTP (fixtures/cpp-clients)", () => {
  it("links libcurl, cpr and cpp-httplib requests to the routes they reach", async () => {
    const graph = await scan("fixtures/cpp-clients");
    const requests = graph.relationships.filter((rel) => rel.type === "REQUESTS").map((rel) => {
      const call = graph.nodes.find((node) => node.id === rel.from)!;
      return `${call.properties.httpClient} ${rel.properties.method} ${rel.properties.url} -> ${label(graph, rel.to)} (${rel.properties.match})`;
    }).sort();
    assert.deepEqual(requests, [
      "cpr GET /api/users -> GET /api/users (exact)",
      "cpr POST /api/users -> POST /api/users (exact)",
      "cpr PUT /api/users/7 -> PUT /api/users/:id (parameter)",
      "httplib GET /api/users -> GET /api/users (exact)",
      "libcurl DELETE /api/users/${id} -> DELETE /api/users/:id (parameter)",
      "libcurl GET /api/users -> GET /api/users (exact)",
      "libcurl POST /api/users -> POST /api/users (exact)",
    ]);
  });
});

describe("C and C++ services in the MCP tools", () => {
  let store: GraphStore;
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;
  before(async () => {
    const graph = await scan("fixtures/cpp-data");
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-cpp-frameworks-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("list_routes answers for a C++ service", async () => {
    const result = await call("list_routes", { framework: "httplib" });
    assert.deepEqual((result.routes as any[]).map((route) => `${route.method} ${route.fullPath}`).sort(), ["GET /api/users", "POST /api/users"]);
  });

  it("list_data_access names the tables of the SQL strings, with the routes that reach them", async () => {
    const result = await call("list_data_access", { model: "users", library: "sqlite3" });
    const rows = result.dataAccess as any[];
    assert.ok(rows.some((row) => row.sourceKind === "Route" && row.operation === "create" && row.table === "users"));
    assert.ok(rows.some((row) => row.sourceName === "addUser" && row.direct === true));
  });

  it("list_env_config answers for getenv reads", async () => {
    const result = await call("list_env_config", {});
    assert.deepEqual((result.envConfig as any[]).map((entry) => entry.name).sort(), ["APP_DB_MODE", "APP_DB_PATH", "APP_PORT"]);
  });

  it("list_tables shows the table a CREATE string declares", async () => {
    const result = await call("list_tables", {});
    assert.ok(JSON.stringify(result).includes("src/store.cpp"));
  });
});
