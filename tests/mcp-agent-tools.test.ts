import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fitToBudget } from "../src/adapters/mcp/budget.js";
import { parseDiff } from "../src/adapters/mcp/agent-tools/impact.js";
import { callMcpTool, mcpToolDefinitions } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { startMcpServer } from "./helpers/mcp-stdio.js";

// A small Express app: route (with route-level middleware) -> handler ->
// service -> prisma, an env read, a class method caller, and a module-level
// call from another file.
const PROJECT_FILES: Record<string, string> = {
  "src/app.ts": [
    "import express from 'express';",
    "import { loadUsers } from './service';",
    "",
    "const app = express();",
    "",
    "function authenticate(req, res, next) {",
    "  next();",
    "}",
    "",
    "async function listUsers(req, res) {",
    "  res.json(await loadUsers());",
    "}",
    "",
    "app.get('/users', authenticate, listUsers);",
    "",
  ].join("\n"),
  "src/service.ts": [
    "import { PrismaClient } from '@prisma/client';",
    "import { formatName } from './format';",
    "",
    "const prisma = new PrismaClient();",
    "",
    "export async function loadUsers() {",
    "  const url = process.env.DB_URL;",
    "  const users = await prisma.user.findMany();",
    "  return users.map((user) => formatName(user.name));",
    "}",
    "",
    "export class UserCache {",
    "  private readonly size = 10;",
    "",
    "  refresh() {",
    "    return loadUsers();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/format.ts": "export function formatName(name: string) {\n  return name.trim();\n}\n",
  "src/boot.ts": "import { formatName } from './format';\n\nformatName(' boot ');\n",
};

const hasGit = spawnSync("git", ["--version"]).status === 0;

async function createProject(): Promise<{ root: string; projectPath: string; databasePath: string; store: GraphStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-agent-tools-"));
  const projectPath = path.join(root, "project");
  const databasePath = path.join(root, "graph");
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  for (const [file, content] of Object.entries(PROJECT_FILES)) {
    await writeFile(path.join(projectPath, file), content, "utf8");
  }
  const graph = await buildCodeGraph(projectPath, { continueOnError: false });
  const store = await GraphStore.open(databasePath);
  await store.reset();
  await store.write(graph.nodes, graph.relationships);
  return { root, projectPath, databasePath, store };
}

async function callJson(store: GraphStore, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await callMcpTool(store, name, args);
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, any>;
}

const names = (rows: Array<{ name?: string; function?: string }>) => rows.map((row) => row.name ?? row.function);

describe("agent MCP tools", () => {
  let project: Awaited<ReturnType<typeof createProject>>;
  before(async () => {
    project = await createProject();
  });
  after(async () => {
    await project.store.close();
  });

  it("registers the seven agent tools after the graph tools", () => {
    const toolNames = mcpToolDefinitions.map((tool) => tool.name);
    assert.equal(toolNames.length, 23);
    assert.deepEqual(toolNames.slice(11, 18), [
      "impact_of", "detect_changes", "route_details", "get_symbol_source", "get_file_outline", "component_tree", "find_component_usages",
    ]);
  });

  it("impact_of walks callers with depth and reaches routes and module code", async () => {
    const impact = await callJson(project.store, "impact_of", { symbol: "formatName" });
    assert.deepEqual(names(impact.seeds), ["formatName"]);
    assert.deepEqual(
      impact.callers.map((caller: any) => [caller.name, caller.className, caller.depth]),
      [["loadUsers", null, 1], ["listUsers", null, 2], ["refresh", "UserCache", 2]],
    );
    assert.deepEqual(impact.moduleCallers.map((call: any) => [call.file, call.line, call.calls]), [["src/boot.ts", 3, "formatName"]]);
    assert.equal(impact.routes.length, 1);
    assert.equal(impact.routes[0].method, "GET");
    assert.equal(impact.routes[0].fullPath, "/users");
    assert.deepEqual(impact.routes[0].reachedThrough, [{ function: "listUsers", functionFile: "src/app.ts", as: "handler" }]);
    // Data access and env vars are reported for the seeds only.
    assert.deepEqual(impact.dataAccess, []);
    assert.deepEqual(impact.envVars, []);

    const shallow = await callJson(project.store, "impact_of", { symbol: "formatName", maxDepth: 1 });
    assert.deepEqual(names(shallow.callers), ["loadUsers"]);
    assert.deepEqual(shallow.routes, []);
  });

  it("impact_of takes a file or a class, and reports what the seeds use", async () => {
    const byFile = await callJson(project.store, "impact_of", { file: "service.ts", maxDepth: 1 });
    assert.deepEqual(names(byFile.seeds), ["loadUsers", "refresh"]);
    assert.deepEqual(names(byFile.callers), ["listUsers"]);
    assert.equal(byFile.dataAccess.length, 1);
    assert.equal(byFile.dataAccess[0].model, "user");
    assert.equal(byFile.dataAccess[0].operation, "read");
    assert.deepEqual(byFile.envVars.map((env: any) => [env.name, names(env.usedBy)]), [["DB_URL", ["loadUsers"]]]);

    const byClass = await callJson(project.store, "impact_of", { symbol: "UserCache" });
    assert.deepEqual(byClass.seeds.map((seed: any) => [seed.className, seed.name]), [["UserCache", "refresh"]]);
    assert.deepEqual(byClass.callers, []);

    const missing = await callJson(project.store, "impact_of", { symbol: "nothingHere" });
    assert.deepEqual(missing.seeds, []);
    assert.match(missing.note, /find_definitions/);
    await assert.rejects(() => callMcpTool(project.store, "impact_of", {}), /symbol or a file/);
  });

  it("route_details lists lifecycle order, the call chain and what the chain uses", async () => {
    const details = await callJson(project.store, "route_details", { method: "get", path: "/users" });
    assert.equal(details.routes.length, 1);
    const [route] = details.routes;
    assert.equal(route.file, "src/app.ts");
    assert.equal(route.line, 14);
    assert.deepEqual(route.lifecycle.map((step: any) => [step.orderIndex, step.role, step.name]), [
      [0, "middleware", "authenticate"],
      [1, "handler", "listUsers"],
    ]);
    assert.deepEqual(route.callChain.map((call: any) => [call.depth, call.caller, call.callee, call.line]), [
      [1, "listUsers", "loadUsers", 11],
      [2, "loadUsers", "formatName", 9],
    ]);
    assert.equal(route.dataAccess.length, 1);
    assert.equal(route.dataAccess[0].expression, "prisma.user.findMany");
    assert.ok(route.dataAccess[0].usedBy.some((use: any) => use.function === "loadUsers"));
    assert.deepEqual(route.envVars.map((env: any) => env.name), ["DB_URL"]);

    const none = await callJson(project.store, "route_details", { method: "POST", path: "/users" });
    assert.deepEqual(none.routes, []);
    assert.match(none.note, /list_routes/);
  });

  it("get_symbol_source slices declarations from disk", async () => {
    const method = await callJson(project.store, "get_symbol_source", { name: "UserCache.refresh" });
    assert.equal(method.matches.length, 1);
    assert.equal(method.matches[0].source, "  refresh() {\n    return loadUsers();\n  }");
    assert.match(method.note, /from disk/);

    const cls = await callJson(project.store, "get_symbol_source", { name: "UserCache", kind: "class" });
    assert.equal(cls.matches[0].line, 12);
    assert.equal(cls.matches[0].endLine, 18);
    assert.ok(cls.matches[0].source.startsWith("export class UserCache {"));

    const none = await callJson(project.store, "get_symbol_source", { name: "UserCache", kind: "function" });
    assert.deepEqual(none.matches, []);
    await assert.rejects(() => callMcpTool(project.store, "get_symbol_source", { name: "x", kind: "widget" }), /Unknown kind/);
  });

  it("get_file_outline lists declarations in line order with class members", async () => {
    const outline = await callJson(project.store, "get_file_outline", { file: "service.ts" });
    assert.equal(outline.file, "src/service.ts");
    assert.deepEqual(outline.imports.map((imp: any) => imp.source), ["@prisma/client", "./format"]);
    assert.deepEqual(outline.outline.map((entry: any) => [entry.kind, entry.name, entry.line]), [
      ["variable", "prisma", 4],
      ["function", "loadUsers", 6],
      ["class", "UserCache", 12],
    ]);
    assert.deepEqual(outline.outline[2].members.map((member: any) => [member.kind, member.name]), [
      ["field", "size"],
      ["method", "refresh"],
    ]);

    const app = await callJson(project.store, "get_file_outline", { file: "src/app.ts" });
    assert.ok(app.outline.some((entry: any) => entry.kind === "route" && entry.name === "GET /users"));

    const missing = await callJson(project.store, "get_file_outline", { file: "nope.ts" });
    assert.equal(missing.outline, null);
  });
});

describe("detect_changes", { skip: hasGit ? false : "git is not installed" }, () => {
  it("maps working-tree changes onto symbols and their impact", async () => {
    const project = await createProject();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd: project.projectPath });
    try {
      git("init", "-q");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      const clean = await callJson(project.store, "detect_changes", {});
      assert.deepEqual(clean.changedFiles, []);
      assert.equal(clean.impact, null);

      // Change the body of loadUsers and add a file the graph has not seen.
      const service = PROJECT_FILES["src/service.ts"]!.replace("const url = process.env.DB_URL;", "const url = process.env.DB_URL ?? '';");
      await writeFile(path.join(project.projectPath, "src/service.ts"), service, "utf8");
      await writeFile(path.join(project.projectPath, "src/new.ts"), "export const fresh = 1;\n", "utf8");

      const changes = await callJson(project.store, "detect_changes", { base: "HEAD" });
      assert.deepEqual(changes.changedFiles, [{
        file: "src/service.ts",
        ranges: ["7"],
        symbols: [{ kind: "function", name: "loadUsers", className: null, line: 6, endLine: 10 }],
      }]);
      assert.deepEqual(changes.unscannedFiles, ["src/new.ts"]);
      assert.match(changes.note, /Rescan/);
      assert.deepEqual(names(changes.impact.callers), ["listUsers", "refresh"]);
      assert.deepEqual(changes.impact.routes.map((route: any) => `${route.method} ${route.fullPath}`), ["GET /users"]);
      assert.deepEqual(changes.impact.envVars.map((env: any) => env.name), ["DB_URL"]);

      await assert.rejects(() => callMcpTool(project.store, "detect_changes", { base: "--output=/tmp/x" }), /Invalid base/);
      await assert.rejects(() => callMcpTool(project.store, "detect_changes", { base: "HEAD; rm -rf /" }), /Invalid base/);
      await assert.rejects(() => callMcpTool(project.store, "detect_changes", { base: "no-such-branch" }), /git diff against no-such-branch failed/);
    } finally {
      await project.store.close();
    }
  });

  it("parses new-side ranges, deletions and deleted files from a zero-context diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3 +3 @@",
      "@@ -10,2 +9,0 @@",
      "@@ -20,0 +20,3 @@",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,4 +0,0 @@",
      "diff --git a/new.ts b/new.ts",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
    ].join("\n");
    assert.deepEqual(Object.fromEntries(parseDiff(diff)), {
      "a.ts": [{ start: 3, end: 3 }, { start: 9, end: 9 }, { start: 20, end: 22 }],
      "gone.ts": [{ start: 1, end: Number.POSITIVE_INFINITY }],
      "new.ts": [{ start: 1, end: 2 }],
    });
  });
});

describe("agent tool output budget", () => {
  it("halves the largest lists until the result fits and reports what was cut", () => {
    const big = {
      callers: Array.from({ length: 1000 }, (_, index) => ({ name: `caller${index}`, file: "src/a.ts", line: index })),
      routes: [{ method: "GET", path: "/" }],
    };
    const fitted = fitToBudget(big, 5_000);
    assert.ok(JSON.stringify(fitted).length <= 5_000);
    assert.deepEqual(fitted.routes, big.routes);
    assert.equal(fitted.callers.length + fitted.truncated!.callers!, 1000);
    assert.equal(big.callers.length, 1000, "the input is not modified");
    assert.equal(fitToBudget({ a: [1] }, 5_000).truncated, undefined);
  });
});

describe("agent tools over stdio", () => {
  it("serves all tools through `concentrate mcp`", async () => {
    const project = await createProject();
    await project.store.close();
    const server = startMcpServer(project.databasePath);
    const tool = async (name: string, args: Record<string, unknown>) =>
      (await server.request("tools/call", { name, arguments: args })).structuredContent;

    try {
      assert.equal((await server.request("initialize", {})).serverInfo.name, "concentrate");
      assert.equal((await server.request("tools/list", {})).tools.length, 23);
      assert.deepEqual(names((await tool("impact_of", { symbol: "loadUsers" })).callers), ["listUsers", "refresh"]);
      assert.equal((await tool("route_details", { method: "GET", path: "/users" })).routes[0].lifecycle.length, 2);
      assert.match((await tool("get_symbol_source", { name: "formatName" })).matches[0].source, /name\.trim/);
      assert.equal((await tool("get_file_outline", { file: "src/format.ts" })).outline[0].name, "formatName");
      // The temp project is not a git repository: a tool error, not a protocol error.
      const changes = await server.request("tools/call", { name: "detect_changes", arguments: {} });
      assert.equal(changes.isError, true);
      assert.match(changes.content[0].text, /not inside a git work tree/);
    } finally {
      await server.close();
    }
  });
});
