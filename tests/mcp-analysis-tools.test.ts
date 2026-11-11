import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { matchName, words } from "../src/adapters/mcp/analysis-tools/search.js";
import { parseReExportNames } from "../src/core/graph/re-exports.js";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { startMcpServer } from "./helpers/mcp-stdio.js";

// A two-package workspace: @w/core publishes a barrel (export * and a named
// re-export); @w/app imports from it, has a runtime import cycle, a
// type-only cycle, a namespace import, an unused export and a dead function.
const PROJECT_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "w", private: true, workspaces: ["packages/*"] }),
  "packages/core/package.json": JSON.stringify({ name: "@w/core", version: "1.0.0", exports: { ".": "./src/index.ts" } }),
  "packages/core/src/index.ts": "export * from './math';\nexport { greet as sayHello } from './greet';\n",
  "packages/core/src/math.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\nexport function unusedMath() {\n  return 0;\n}\n",
  "packages/core/src/greet.ts": "export function greet(name: string) {\n  return `hi ${name}`;\n}\n",
  "packages/app/package.json": JSON.stringify({ name: "@w/app", version: "1.0.0", private: true, dependencies: { "@w/core": "workspace:*" } }),
  "packages/app/src/main.ts": [
    "import { add, sayHello } from '@w/core';",
    "import * as util from './util';",
    "import { usedHelper } from './helpers';",
    "import { first } from './cycle-a';",
    "",
    "export function main() {",
    "  return [add(1, 2), sayHello('x'), util.value, usedHelper(), first()];",
    "}",
    "",
  ].join("\n"),
  "packages/app/src/util.ts": "export const value = 1;\nexport function neverNamed() {\n  return 2;\n}\n",
  "packages/app/src/helpers.ts": [
    "export function usedHelper() {",
    "  return getUserService();",
    "}",
    "export function unusedHelper() {",
    "  return 3;",
    "}",
    "function getUserService() {",
    "  return 'service';",
    "}",
    "function forgotten() {",
    "  return 4;",
    "}",
    "",
  ].join("\n"),
  "packages/app/src/cycle-a.ts": "import { second } from './cycle-b';\nexport function first() {\n  return second();\n}\n",
  "packages/app/src/cycle-b.ts": "import { third } from './cycle-c';\nexport function second() {\n  return third();\n}\n",
  "packages/app/src/cycle-c.ts": "import { first } from './cycle-a';\nexport function third() {\n  return first.name;\n}\n",
  "packages/app/src/types-a.ts": "import type { B } from './types-b';\nexport type A = { b?: B };\n",
  "packages/app/src/types-b.ts": "import type { A } from './types-a';\nexport type B = { a?: A };\n",
  "packages/app/src/shapes.ts": "export interface Shape {}\nexport class Base {}\nexport class Square extends Base implements Shape {}\n",
  "packages/app/src/shapes.test.ts": "import { Square } from './shapes';\nexport const sample = new Square();\n",
};

async function createProject(files: Record<string, string> = PROJECT_FILES) {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-analysis-"));
  const projectPath = path.join(root, "project");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(projectPath, file)), { recursive: true });
    await writeFile(path.join(projectPath, file), content, "utf8");
  }
  const graph = await buildCodeGraph(projectPath, { continueOnError: false });
  const databasePath = path.join(root, "graph");
  const store = await GraphStore.open(databasePath);
  await store.reset();
  await store.write(graph.nodes, graph.relationships);
  return { databasePath, store };
}

describe("analysis MCP tools", () => {
  let project: Awaited<ReturnType<typeof createProject>>;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(project.store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    project = await createProject();
  });
  after(async () => {
    await project.store.close();
  });

  it("ranks fuzzy name matches", () => {
    assert.deepEqual(words("getUserService"), ["get", "User", "Service"]);
    assert.deepEqual(words("parseHTTPRequest2"), ["parse", "HTTP", "Request", "2"]);
    const order = ["Injector", "injector", "InjectorRef", "getInjector", "IndexJoinCollector"]
      .map((name) => ({ name, match: matchName(name, "Injector") }))
      .sort((a, b) => b.match!.score - a.match!.score)
      .map(({ name, match }) => `${name}:${match!.match}`);
    assert.deepEqual(order, ["Injector:exact", "injector:exact-ignore-case", "InjectorRef:prefix", "getInjector:substring", "IndexJoinCollector:fuzzy"]);
    assert.equal(matchName("getUserService", "gUS")?.match, "initials");
    assert.equal(matchName("Injector", "injctr")?.match, "fuzzy");
    assert.ok(matchName("Injector", "injctr")!.score > matchName("injectRouteOptions", "injctr")!.score);
    assert.equal(matchName("Injector", "xyz"), null);
  });

  it("search_symbols finds and pages declarations", async () => {
    const initials = await tool("search_symbols", { query: "gUS" });
    assert.equal(initials.symbols[0].name, "getUserService");
    assert.equal(initials.symbols[0].match, "initials");

    const all = await tool("search_symbols", { query: "e", limit: 200 });
    const first = await tool("search_symbols", { query: "e", limit: 3 });
    const second = await tool("search_symbols", { query: "e", limit: 200, cursor: first.page.nextCursor });
    assert.deepEqual([...first.symbols, ...second.symbols], all.symbols);
    assert.equal(all.total, all.symbols.length);

    const classes = await tool("search_symbols", { query: "s", kind: "class" });
    assert.deepEqual(classes.symbols.map((symbol: any) => symbol.name).sort(), ["Base", "Square"]);
    const result = await callMcpTool(project.store, "search_symbols", { query: "x", kind: "widget" }).catch((error: Error) => error);
    assert.match(String(result), /Unknown kind/);
  });

  it("find_references follows imports through barrels and renames", async () => {
    // The add(1, 2) call goes through the export * barrel; call resolution
    // follows it to math.ts.
    const add = await tool("find_references", { symbol: "add" });
    assert.deepEqual(add.references.map((reference: any) => `${reference.kind} ${reference.file}:${reference.line}`), [
      "import packages/app/src/main.ts:1",
      "call packages/app/src/main.ts:7",
      "re-export packages/core/src/index.ts:1",
    ]);
    const helper = await tool("find_references", { symbol: "usedHelper" });
    assert.deepEqual(helper.references.map((reference: any) => `${reference.kind} ${reference.from ?? ""} ${reference.file}:${reference.line}`), [
      "import  packages/app/src/main.ts:3",
      "call main packages/app/src/main.ts:7",
    ]);
    assert.deepEqual(helper.counts, { import: 1, call: 1 });

    const greet = await tool("find_references", { symbol: "greet" });
    const kinds = greet.references.map((reference: any) => `${reference.kind}:${reference.detail}`);
    assert.ok(kinds.includes("import:sayHello"), JSON.stringify(greet.references));
    assert.ok(kinds.includes("re-export:greet as sayHello"));
    assert.ok(kinds.includes("call:sayHello"), "the renamed re-export resolves the call");

    const value = await tool("find_references", { symbol: "value" });
    assert.equal(value.references[0].kind, "namespace-import");
    assert.equal(value.references[0].possible, true);

    const base = await tool("find_references", { symbol: "Base" });
    assert.ok(base.references.some((reference: any) => reference.kind === "extends" && reference.from === "Square"));
    const shape = await tool("find_references", { symbol: "Shape" });
    assert.ok(shape.references.some((reference: any) => reference.kind === "implements" && reference.from === "Square"));

    assert.equal((await tool("find_references", { symbol: "nothingHere" })).declarations.length, 0);
  });

  it("find_import_cycles separates runtime and type-only cycles", async () => {
    const files = await tool("find_import_cycles", {});
    assert.equal(files.total, 2);
    assert.equal(files.runtimeCycles, 1);
    const [runtime, types] = files.cycles;
    assert.deepEqual(runtime.cycle, ["packages/app/src/cycle-a.ts", "packages/app/src/cycle-b.ts", "packages/app/src/cycle-c.ts", "packages/app/src/cycle-a.ts"]);
    assert.equal(runtime.typeOnly, false);
    assert.deepEqual(types.members, ["packages/app/src/types-a.ts", "packages/app/src/types-b.ts"]);
    assert.equal(types.typeOnly, true);

    const scoped = await tool("find_import_cycles", { path: "src/cycle-b.ts" });
    assert.equal(scoped.total, 1);
    assert.equal(scoped.path, "src/cycle-b.ts");
    assert.equal(scoped.cycles[0].size, 3);
    assert.equal(scoped.cycles[0].matchingMembers, 1);
    assert.deepEqual(scoped.cycles[0].members, ["packages/app/src/cycle-b.ts"]);
    assert.equal(scoped.cycles[0].cycle[0], "packages/app/src/cycle-b.ts");
    const directory = await tool("find_import_cycles", { path: "packages/app/src/" });
    assert.equal(directory.total, 2);
    assert.equal(directory.cycles[0].matchingMembers, 3);
    assert.equal((await tool("find_import_cycles", { path: "app/src" })).total, 2, "directory in the middle of the path");
    assert.equal((await tool("find_import_cycles", { path: "packages/core" })).total, 0);
    assert.equal((await tool("find_import_cycles", { path: "cycle" })).total, 0, "no partial name matches");

    const packages = await tool("find_import_cycles", { scope: "package" });
    assert.equal(packages.total, 0);
    const invalid = await callMcpTool(project.store, "find_import_cycles", { scope: "galaxy" }).catch((error: Error) => error);
    assert.match(String(invalid), /Unknown scope/);
  });

  it("find_unused_exports lists candidates and what it skipped", async () => {
    const result = await tool("find_unused_exports", {});
    const names = result.unusedExports.map((entry: any) => entry.name).sort();
    // unusedMath is exported through the package entry barrel, so it is public;
    // util.ts is imported as a namespace; main is used by nothing in the repo;
    // Base and Shape are only used inside shapes.ts.
    assert.deepEqual(names, ["Base", "Shape", "main", "unusedHelper"]);
    assert.equal(result.unusedExports.find((entry: any) => entry.name === "Base").usedInFile, true);
    assert.ok(!names.includes("unusedMath"));
    assert.ok(!names.includes("neverNamed"));
    assert.ok(!names.includes("Square"), "used by the test file");
    assert.deepEqual(result.deadFunctions.map((entry: any) => entry.name), ["forgotten"]);
    assert.equal(result.skipped.packageEntry, 1, "unusedMath, through the entry barrel");
    assert.equal(result.skipped.wholeFileImported, 2);
    assert.equal(result.skipped.tests, 1);

    const withTests = await tool("find_unused_exports", { includeTests: true });
    assert.ok(withTests.unusedExports.some((entry: any) => entry.name === "sample"));
    const scoped = await tool("find_unused_exports", { file: "helpers.ts" });
    assert.deepEqual(scoped.unusedExports.map((entry: any) => entry.name), ["unusedHelper"]);
    for (const directory of ["packages/app/src", "packages/app/src/", "app/src"]) {
      const inDirectory = await tool("find_unused_exports", { file: directory });
      assert.deepEqual(inDirectory.unusedExports.map((entry: any) => entry.name).sort(), ["Base", "Shape", "main", "unusedHelper"], directory);
    }
  });

  it("architecture_overview groups packages and directories", async () => {
    const packages = await tool("architecture_overview", {});
    assert.deepEqual(packages.groups.map((group: any) => group.name), ["@w/app", "@w/core"]);
    const app = packages.groups[0];
    assert.equal(app.testFiles, 1);
    assert.equal(app.dependsOn, 1);
    const edge = packages.edges.find((entry: any) => entry.from === "@w/app" && entry.to === "@w/core");
    assert.equal(edge.imports, 1);
    assert.ok(edge.dependencyTypes.includes("dependencies"));

    const directories = await tool("architecture_overview", { level: "directory", depth: 2 });
    assert.deepEqual(directories.groups.map((group: any) => group.name), ["packages/app", "packages/core"]);
    assert.equal(directories.edges[0].from, "packages/app");
  });

  it("parses named re-exports", () => {
    assert.deepEqual(parseReExportNames("export { a, b as c, type D } from './x';"), [
      { imported: "a", exported: "a" },
      { imported: "b", exported: "c" },
      { imported: "D", exported: "D" },
    ]);
    assert.deepEqual(parseReExportNames("export * from './x';"), []);
  });

  it("serves the analysis tools over stdio", async () => {
    await project.store.close();
    const server = startMcpServer(project.databasePath);
    try {
      const names = (await server.request("tools/list", {})).tools.map((definition: any) => definition.name);
      for (const name of ["search_symbols", "find_references", "find_import_cycles", "find_unused_exports", "architecture_overview"]) assert.ok(names.includes(name), name);
      const call = async (name: string, args: Record<string, unknown>) => (await server.request("tools/call", { name, arguments: args })).structuredContent;
      assert.equal((await call("search_symbols", { query: "usedHelper" })).symbols[0].match, "exact");
      assert.ok((await call("find_references", { symbol: "first" })).total > 0);
      assert.equal((await call("find_import_cycles", {})).total, 2);
      assert.deepEqual((await call("find_unused_exports", {})).deadFunctions.map((entry: any) => entry.name), ["forgotten"]);
      assert.equal((await call("architecture_overview", {})).groups.length, 2);
    } finally {
      await server.close();
      project.store = await GraphStore.open(project.databasePath);
    }
  });
});

describe("analysis MCP tools on Go", () => {
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/go-entrypoints"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-go-unused-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("find_unused_exports judges Go exports by package", async () => {
    const result = await tool("find_unused_exports", {});
    // Add is called and DefaultName / Verbose are named from package main;
    // Subtract is only used by its own package's test.
    assert.deepEqual(result.unusedExports.map((entry: any) => entry.name).sort(), ["Debug", "Options", "Subtract", "Unused", "Version"]);
    assert.deepEqual(result.deadFunctions.map((entry: any) => entry.name), ["forgotten"]);
    assert.equal(result.skipped.goMain, 1, "Run in package main");
    assert.ok(result.skipped.tests >= 4);
  });
});

describe("file type filters", () => {
  it("search_symbols, find_definitions and list_exports filter by sourceType and language", async () => {
    const typed = await createProject({
      "package.json": JSON.stringify({ name: "t", private: true }),
      "src/add.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "src/add.test.ts": "export const sample = 1;\n",
      "tools/add.go": "package tools\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n",
    });
    try {
    const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(typed.store, name, args)).structuredContent as Record<string, any>;
    const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name).sort();
    const all = await tool("search_symbols", { query: "add" });
    assert.ok(names(all.symbols).includes("add") && names(all.symbols).includes("Add"));
    const goOnly = await tool("search_symbols", { query: "add", language: "go" });
    assert.deepEqual(names(goOnly.symbols), ["Add"]);
    assert.equal(goOnly.query.language, "go");
    const ts = await tool("search_symbols", { query: "add", language: "TypeScript" });
    assert.deepEqual(names(ts.symbols), ["add"]);

    const tests = await tool("search_symbols", { query: "sample", sourceType: "test" });
    assert.deepEqual(names(tests.symbols), ["sample"]);
    assert.equal((await tool("search_symbols", { query: "sample", sourceType: "production" })).total, 0);
    assert.equal((await tool("search_symbols", { query: "sample", sourceType: "test", language: "go" })).total, 0);
    assert.equal((await tool("search_symbols", { query: "sample", language: "cobol" })).total, 0);

    const defsAll = await tool("find_definitions", { name: "sample" });
    assert.equal(defsAll.definitions.length, 1);
    assert.equal((await tool("find_definitions", { name: "sample", sourceType: "test" })).definitions.length, 1);
    assert.equal((await tool("find_definitions", { name: "sample", sourceType: "production" })).definitions.length, 0);
    const goDefs = await tool("find_definitions", { name: "add", language: "go" });
    assert.deepEqual(goDefs.definitions.map((row: any) => row.file), ["tools/add.go"]);
    assert.equal(goDefs.query.language, "go");

    const testExports = await tool("list_exports", { sourceType: "test" });
    assert.deepEqual(testExports.exports.map((row: any) => row.file), ["src/add.test.ts"]);
    const goExports = await tool("list_exports", { language: "go" });
    assert.deepEqual(goExports.exports.map((row: any) => row.name), ["Add"]);

    await assert.rejects(callMcpTool(typed.store, "search_symbols", { query: "x", sourceType: "prod" }), /Unknown sourceType/);
    await assert.rejects(callMcpTool(typed.store, "find_definitions", { name: "x", sourceType: "prod" }), /Unknown sourceType/);
    } finally {
      await typed.store.close();
    }
  });
});

describe("analysis MCP tools on Rust", () => {
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/rust-unused"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-rust-unused-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("find_unused_exports judges pub items by crate", async () => {
    const result = await tool("find_unused_exports", {});
    // The tool crate calls used_fn and geometry::area and names Mode, Used and
    // LIMIT; pub(crate) internal is no export; main_helper sits in a binary crate.
    assert.deepEqual(result.unusedExports.map((entry: any) => entry.name).sort(), ["Alias", "Orphan", "Plugin", "UNUSED_LIMIT", "perimeter", "unused_fn"]);
    // private_dead is only used by a test; only_in_tests is test code.
    assert.deepEqual(result.deadFunctions.map((entry: any) => entry.name), []);
    assert.ok(result.skipped.rustBinary >= 1);
  });
});
