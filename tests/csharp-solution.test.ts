import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import { findUnusedExports } from "../src/adapters/mcp/analysis-tools/unused.js";
import { pageWindow } from "../src/adapters/mcp/paging.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { BuildCodeGraphResult } from "../src/core/scan/result.js";
import { openTestStore } from "./helpers/store.js";

// Phase 45 acceptance (issue #285): a solution fixture with two class libraries, a web project and a test project has
// the expected projects, references and entrypoints, and global usings in one project do not resolve names in another.
// The full graph is pinned by tests/golden/fixtures/csharp-solution.jsonl.

const strip = (id: string): string => id.replace(/^file:/u, "");

describe("C# solution acceptance (fixtures/csharp-solution)", () => {
  let graph: BuildCodeGraphResult;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures", "csharp-solution"), { continueOnError: false, concurrency: 2 });
  });

  const packages = () => graph.nodes.filter((node) => node.label === "Package" && node.properties.manager === "dotnet");
  const byId = (id: string) => graph.nodes.find((node) => node.id === id);
  const named = (id: string) => String(byId(id)?.properties.name);

  it("finds the five projects, including the one outside every solution", () => {
    assert.deepEqual(
      packages().map((node) => `${node.properties.name} ${node.properties.projectFile} ${node.properties.sdk}`).sort(),
      [
        "Orphan tools/Orphan/Orphan.csproj Microsoft.NET.Sdk",
        "Shop.Core src/Shop.Core/Shop.Core.csproj Microsoft.NET.Sdk",
        "Shop.Data src/Shop.Data/Shop.Data.csproj Microsoft.NET.Sdk",
        "Shop.Tests tests/Shop.Tests/Shop.Tests.csproj Microsoft.NET.Sdk",
        "Shop.Web src/Shop.Web/Shop.Web.csproj Microsoft.NET.Sdk.Web",
      ],
    );
    const solutions = (name: string) => JSON.parse(String(packages().find((node) => node.properties.name === name)?.properties.solutions));
    assert.deepEqual(solutions("Shop.Core"), ["Shop.sln", "Shop.slnx"]);
    assert.deepEqual(solutions("Orphan"), []);
    assert.equal(packages().find((node) => node.properties.name === "Shop.Web")?.properties.unresolved, 2);
  });

  it("links the projects by ProjectReference", () => {
    const ids = new Set(packages().map((node) => node.id));
    const edges = graph.relationships
      .filter((rel) => rel.type === "PACKAGE_IMPORTS_PACKAGE" && ids.has(rel.from) && ids.has(rel.to))
      .map((rel) => `${named(rel.from)} -> ${named(rel.to)}`);
    assert.deepEqual([...new Set(edges)].sort(), ["Shop.Data -> Shop.Core", "Shop.Tests -> Shop.Core", "Shop.Web -> Shop.Core", "Shop.Web -> Shop.Data"]);
  });

  it("makes an EntryPoint of each executable project, running the top-level statements or Main", () => {
    const entries = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "csharp-project").map((node) => node.id).sort();
    assert.deepEqual(entries, ["entrypoint:csharp:src/Shop.Web/Shop.Web.csproj", "entrypoint:csharp:tools/Orphan/Orphan.csproj"]);
    const runs = (id: string) => graph.relationships.filter((rel) => rel.type === "RUNS" && rel.from === id).map((rel) => rel.to);
    // RUNS targets the `main` EntryPoint of the file, whose handler is the top-level statements or Main.
    const handlers = (id: string) => runs(id).map((target) => `${strip(target).split(":entrypoint:")[0]} ${byId(target)?.properties.handlerName}`);
    assert.deepEqual(handlers(entries[0]!), ["src/Shop.Web/Program.cs <top-level>"]);
    assert.deepEqual(handlers(entries[1]!), ["tools/Orphan/Program.cs Main"]);
    // CS7022: Shop.Web has top-level statements, so Launcher.Main is not a standalone entrypoint.
    const mains = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "main").map((node) => node.id);
    assert.ok(!mains.some((id) => id.includes("Launcher.cs")), mains.join("\n"));
  });

  it("does not resolve Shop.Data names in Shop.Core through Shop.Data's global using", () => {
    const record = "src/Shop.Data/Models/OrderRecord.cs";
    const fromCore = graph.relationships.filter((rel) => strip(rel.from).startsWith("src/Shop.Core/") && strip(rel.to).includes(record));
    assert.deepEqual(fromCore, []);
    // The same global using resolves inside Shop.Data, and Shop.Core's own applies to Shop.Core.
    const resolves = (from: string, to: string) =>
      graph.relationships.some((rel) => rel.type === "RESOLVES_TO" && strip(rel.from).startsWith(`${from}:import`) && strip(rel.to) === to);
    assert.ok(resolves("src/Shop.Data/GlobalUsings.cs", record));
    assert.ok(resolves("src/Shop.Core/GlobalUsings.cs", "src/Shop.Core/Abstractions/IClock.cs"));
    assert.ok(!resolves("src/Shop.Core/GlobalUsings.cs", record));
  });

  it("writes to the graph store and reports no unused project entrypoints or Program types", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "csharp-solution-"));
    const store = await openTestStore(path.join(dir, "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const result = await findUnusedExports(store, {}, pageWindow("find_unused_exports", {}, 50));
      const names = result.unusedExports.map((entry) => `${entry.file}:${entry.className ? `${entry.className}.` : ""}${entry.name}`);
      assert.ok(!names.some((name) => name.includes("Program.cs") || name.includes("Launcher.cs")), names.join("\n"));
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
