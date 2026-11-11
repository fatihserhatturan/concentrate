import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

describe("C and C++ build targets in the MCP tools", () => {
  let store: GraphStore;
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-cpp-build-"));
    const graph = await buildCodeGraph(path.resolve("fixtures/cpp-cmake"), { continueOnError: false });
    store = await GraphStore.open(path.join(root, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> =>
    JSON.parse((await callMcpTool(store, name, args)).content[0]!.text) as Record<string, any>;

  it("list_entrypoints lists the executable targets and the main each one runs", async () => {
    const entries = (await call("list_entrypoints", { kind: "cmake-executable" })).entrypoints as any[];
    assert.deepEqual(entries.map((entry) => `${entry.trigger}@${entry.file}`).sort(), ["demo@app/CMakeLists.txt", "pack@tools/CMakeLists.txt", "unpack@tools/CMakeLists.txt"]);
    const demo = entries.find((entry) => entry.trigger === "demo");
    assert.deepEqual(demo.runs.map((run: any) => run.file), ["app/main.cpp"]);
  });

  it("impact_of names the executable targets that run a source file", async () => {
    const impact = await call("impact_of", { file: "tools/pack.cpp" });
    assert.deepEqual((impact.runners ?? []).map((runner: any) => `${runner.depth}:${runner.kind}:${runner.trigger}@${runner.file}`), ["1:cmake-executable:pack@tools/CMakeLists.txt"]);
  });

  it("the graph summary lists the targets as packages with their manager", async () => {
    const packages = await call("architecture_overview", {});
    const names = JSON.stringify(packages);
    for (const name of ["core", "net", "demo"]) assert.ok(names.includes(`"${name}"`), name);
  });
});
