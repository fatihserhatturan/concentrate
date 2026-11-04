import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { McpProtocolError } from "../src/adapters/mcp/errors.js";
import { pagedResult, pageWindow } from "../src/adapters/mcp/paging.js";
import { GRAPH_SUMMARY_URI } from "../src/adapters/mcp/resources.js";
import { handleMcpRequest, MODERN_PROTOCOL_VERSION } from "../src/adapters/mcp/server.js";
import { SCHEMA_VERSION } from "../src/adapters/store/schema.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { startMcpServer } from "./helpers/mcp-stdio.js";

const FUNCTIONS = 37;

// Many small functions to page through, a route and an env read.
async function createProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-protocol-"));
  const projectPath = path.join(root, "project");
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  await writeFile(path.join(projectPath, "package.json"), JSON.stringify({ name: "protocol-app", dependencies: { express: "4.0.0" } }));
  for (let file = 0; file < 4; file += 1) {
    const lines = [];
    for (let index = file; index < FUNCTIONS; index += 4) lines.push(`export function handler${index}() { return ${index}; }`);
    await writeFile(path.join(projectPath, "src", `part${file}.ts`), `${lines.join("\n")}\n`);
  }
  await writeFile(path.join(projectPath, "src", "app.ts"), [
    "import express from 'express';",
    "import { handler0 } from './part0';",
    "const app = express();",
    "app.get('/items', (req, res) => res.json(handler0()));",
    "app.listen(process.env.PORT);",
    "",
  ].join("\n"));
  const graph = await buildCodeGraph(projectPath, { continueOnError: false });
  const databasePath = path.join(root, "graph");
  const store = await GraphStore.open(databasePath);
  await store.reset();
  await store.write(graph.nodes, graph.relationships);
  return { databasePath, store };
}

const modern = (extra: Record<string, unknown> = {}) => ({
  ...extra,
  _meta: {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  },
});

describe("MCP protocol", () => {
  let project: Awaited<ReturnType<typeof createProject>>;
  let opened = 0;
  const engine = async () => {
    opened += 1;
    return project.store;
  };
  const call = (method: string, params: Record<string, unknown> = {}) => handleMcpRequest({ jsonrpc: "2.0", id: 1, method, params }, engine) as Promise<any>;
  const tool = async (name: string, args: Record<string, unknown>) => (await call("tools/call", { name, arguments: args })).structuredContent;
  const rejectsWith = async (promise: Promise<unknown>, code: number, message: RegExp) => {
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof McpProtocolError);
      assert.equal(error.code, code);
      assert.match(error.message, message);
      return true;
    });
  };

  before(async () => {
    project = await createProject();
  });
  after(async () => {
    await project.store.close();
  });

  it("describes itself through server/discover without opening the graph", async () => {
    opened = 0;
    const discover = await call("server/discover", modern());
    assert.equal(discover.resultType, "complete");
    assert.deepEqual(discover._meta["io.modelcontextprotocol/serverInfo"], { name: "concentrate", version: "0.1.0" });
    assert.equal(discover.supportedVersions[0], MODERN_PROTOCOL_VERSION);
    assert.ok(discover.supportedVersions.includes("2024-11-05"));
    assert.deepEqual(discover.capabilities, { tools: {}, resources: {} });
    assert.match(discover.instructions, /nextCursor/);
    assert.equal(discover.cacheScope, "public");
    assert.ok(discover.ttlMs > 0);

    const list = await call("tools/list", modern());
    assert.equal(list.resultType, "complete");
    assert.equal(list.cacheScope, "public");
    assert.equal(list.nextCursor, undefined);
    for (const definition of list.tools) {
      assert.ok(definition.title, `${definition.name} has a title`);
      assert.deepEqual(definition.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    const definitions = list.tools.find((definition: any) => definition.name === "find_definitions");
    assert.ok(definitions.inputSchema.properties.cursor);
    const stats = list.tools.find((definition: any) => definition.name === "graph_stats");
    assert.equal(stats.inputSchema.properties.cursor, undefined, "unpaged tools take no cursor");
    // What the model reads with every request stays small: shared rules are
    // in the instructions, not repeated per tool.
    assert.match(discover.instructions, /characters are shortened/);
    const visible = list.tools.map(({ name, description, inputSchema }: any) => ({ name, description, inputSchema }));
    assert.ok(JSON.stringify(visible).length < 19_000, `tool list is ${JSON.stringify(visible).length} characters`);
    for (const { name, description } of visible) assert.doesNotMatch(description, /characters are shortened/, name);
    assert.equal(opened, 0);
  });

  it("rejects unsupported protocol versions and removed methods", async () => {
    const params = { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } };
    await assert.rejects(call("tools/list", params), (error: unknown) => {
      assert.ok(error instanceof McpProtocolError);
      assert.equal(error.code, -32022);
      assert.deepEqual(error.data, { supported: [MODERN_PROTOCOL_VERSION], requested: "2099-01-01" });
      return true;
    });
    await rejectsWith(call("ping", modern()), -32601, /Method not found: ping/);
    await rejectsWith(call("prompts/list", modern()), -32601, /Method not found/);
    await rejectsWith(handleMcpRequest({ id: 1 }, engine), -32600, /Invalid request/);
  });

  it("negotiates legacy versions through initialize", async () => {
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
      assert.equal((await call("initialize", { protocolVersion: version })).protocolVersion, version);
    }
    const fallback = await call("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "old" } });
    assert.equal(fallback.protocolVersion, "2025-11-25");
    assert.deepEqual(fallback.capabilities, { tools: {}, resources: {} });
    assert.equal(fallback.serverInfo.name, "concentrate");
    assert.equal(fallback.resultType, undefined, "legacy results keep the legacy shape");
    assert.deepEqual(await call("ping"), {});
    assert.equal((await call("tools/list")).ttlMs, undefined);
  });

  it("returns structured content, and tool failures as isError results", async () => {
    const result = await call("tools/call", modern({ name: "graph_stats", arguments: {} }));
    assert.equal(result.resultType, "complete");
    assert.equal(result.structuredContent.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.isError, undefined);

    const missing = await call("tools/call", modern({ name: "find_definitions", arguments: {} }));
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Missing required string argument: name/);

    await rejectsWith(call("tools/call", modern({ name: "no_such_tool", arguments: {} })), -32602, /Unknown tool: no_such_tool/);
    await rejectsWith(call("tools/call", modern({ arguments: {} })), -32602, /needs a tool name/);
    await rejectsWith(call("tools/call", modern({ name: "graph_stats", arguments: [1] })), -32602, /must be an object/);
  });

  it("pages through a list without repeating or losing items", async () => {
    const all = await tool("find_definitions", { name: "handler", limit: 200 });
    assert.equal(all.definitions.length, FUNCTIONS);
    assert.deepEqual(all.page, { offset: 0, returned: FUNCTIONS });

    const seen = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await tool("find_definitions", { name: "handler", limit: 10, ...(cursor ? { cursor } : {}) });
      assert.equal(page.page.offset, seen.length);
      assert.equal(page.page.returned, page.definitions.length);
      seen.push(...page.definitions);
      cursor = page.page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 4);
    assert.deepEqual(seen, all.definitions);

    // The limit may change between pages; the other arguments may not.
    const first = await tool("find_definitions", { name: "handler", limit: 10 });
    const wider = await tool("find_definitions", { name: "handler", limit: 30, cursor: first.page.nextCursor });
    assert.deepEqual(wider.definitions, all.definitions.slice(10, 37));
    const other = await call("tools/call", { name: "find_definitions", arguments: { name: "handle", cursor: first.page.nextCursor } });
    assert.equal(other.isError, true);
    assert.match(other.content[0].text, /different find_definitions call/);
    const broken = await call("tools/call", { name: "list_routes", arguments: { cursor: "not-a-cursor" } });
    assert.equal(broken.isError, true);
    assert.match(broken.content[0].text, /Invalid cursor/);
  });

  it("pages agent tools' primary lists", async () => {
    const first = await tool("get_file_outline", { file: "src/part0.ts", limit: 4 });
    assert.equal(first.outline.length, 4);
    const rest = await tool("get_file_outline", { file: "src/part0.ts", cursor: first.page.nextCursor });
    assert.equal(rest.page.offset, 4);
    assert.equal(rest.page.nextCursor, undefined);
    assert.deepEqual([...first.outline, ...rest.outline].map((entry: any) => entry.name), (await tool("get_file_outline", { file: "src/part0.ts" })).outline.map((entry: any) => entry.name));
  });

  it("shortens a page that would exceed the output budget", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ index, text: "x".repeat(200) }));
    const window = pageWindow("t", { limit: 40 }, 20);
    const result = pagedResult("t", { limit: 40 }, window, { query: {}, rows: window.take(rows) }, "rows", 3_000) as any;
    assert.ok(JSON.stringify(result).length <= 3_000);
    assert.ok(result.rows.length > 1 && result.rows.length < 40);
    assert.equal(result.page.returned, result.rows.length);
    assert.equal(result.page.shortenedToFit, true);

    const next = pageWindow("t", { limit: 40, cursor: result.page.nextCursor }, 20);
    assert.equal(next.offset, result.rows.length, "the next page starts after the shortened one");
  });

  it("serves the graph summary resource", async () => {
    const list = await call("resources/list", modern());
    assert.deepEqual(list.resources.map((resource: any) => resource.uri), [GRAPH_SUMMARY_URI]);
    assert.equal(list.cacheScope, "public");

    const read = await call("resources/read", modern({ uri: GRAPH_SUMMARY_URI }));
    assert.equal(read.cacheScope, "private");
    assert.equal(read.ttlMs, 0);
    assert.equal(read.contents[0].mimeType, "application/json");
    const summary = JSON.parse(read.contents[0].text);
    assert.equal(summary.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(summary.files, { total: 5, tests: 0 });
    assert.deepEqual(summary.languages, [{ name: "typescript", count: 5 }]);
    assert.deepEqual(summary.topDirectories, [{ name: "src", count: 5 }]);
    assert.deepEqual(summary.packages.map((entry: any) => entry.name), ["protocol-app"]);
    assert.equal(summary.routesByFramework["express-koa"], 1);
    assert.equal(summary.envVars, 1);

    await rejectsWith(call("resources/read", modern({ uri: "concentrate://nope" })), -32602, /Resource not found/);
    await rejectsWith(call("resources/read", modern()), -32602, /needs a uri/);
  });

  it("speaks both eras over stdio", async () => {
    const server = startMcpServer(project.databasePath);
    try {
      const discover = await server.request("server/discover", modern());
      assert.equal(discover.supportedVersions[0], MODERN_PROTOCOL_VERSION);
      const tools = await server.request("tools/list", modern());
      assert.equal(tools.resultType, "complete");
      const routes = await server.request("tools/call", modern({ name: "list_routes", arguments: {} }));
      assert.equal(routes.structuredContent.routes[0].path, "/items");
      const resource = await server.request("resources/read", modern({ uri: GRAPH_SUMMARY_URI }));
      assert.equal(JSON.parse(resource.contents[0].text).files.total, 5);
      const unsupported = await server.send("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2020-01-01" } });
      assert.equal(unsupported.error?.code, -32022);
      const unknown = await server.send("tools/call", modern({ name: "nope" }));
      assert.equal(unknown.error?.code, -32602);
    } finally {
      await server.close();
    }

    const legacy = startMcpServer(project.databasePath);
    try {
      const initialize = await legacy.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } });
      assert.equal(initialize.protocolVersion, "2025-06-18");
      legacy.notify("notifications/initialized");
      assert.deepEqual(await legacy.request("ping", {}), {});
      const definitions = await legacy.request("tools/call", { name: "find_definitions", arguments: { name: "handler", limit: 5 } });
      assert.equal(definitions.structuredContent.definitions.length, 5);
      assert.ok(definitions.structuredContent.page.nextCursor);
    } finally {
      await legacy.close();
    }
  });
});
