import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

describe("Go interfaces matched by signature, closure parameters and shadowed names", () => {
  let graph: Graph;
  let byId: Map<string, GraphNode>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-signatures"), { continueOnError: false });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });

  it("makes a struct implement only the interfaces whose method signatures it has", () => {
    const implementations = graph.relationships
      .filter((rel) => rel.type === "IMPLEMENTS")
      .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${rel.to.split(":")[1]!.split("/")[0]} ${byId.get(rel.to)!.properties.name}`)
      .sort();
    // Two packages' Users and User: each struct implements the one whose
    // result is its own package's type.
    assert.deepEqual(implementations, ["Local -> other Users", "PostRepo -> repo Posts", "Remote -> repo Users", "UserRepo -> repo Users"]);
  });

  it("resolves calls in closures, on a closure's parameter and past a nested redeclaration", () => {
    const resolved = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.from.startsWith("file:main.go:"))
      .map((rel) => `${byId.get(rel.from)!.properties.line} ${byId.get(rel.from)!.properties.expression} -> ${byId.get(rel.to)!.properties.className ?? ""}.${byId.get(rel.to)!.properties.name}`)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
    assert.deepEqual(resolved, [
      "12 s.users.Get -> Remote.Get",
      "12 s.users.Get -> UserRepo.Get",
      "15 s.posts.Get -> PostRepo.Get",
      "25 repo.Run -> .Run",
      "26 tx.Save -> Tx.Save",
      "32 svc.Load -> Service.Load",
      "33 save -> .save",
    ]);
  });

  it("lists an interface's implementations with its definition and the implementation each caller reaches", async () => {
    const store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-go-signatures-")), "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const call = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

      const definitions = (await call("find_definitions", { name: "Users", exact: true })).definitions;
      assert.deepEqual(definitions.map((row: any) => [row.file, row.implementations]), [
        ["other/other.go", [{ name: "Local", file: "other/other.go", line: 11 }]],
        ["repo/repo.go", [{ name: "Remote", file: "impl/remote.go", line: 7 }, { name: "UserRepo", file: "repo/repo.go", line: 16 }]],
      ]);
      const plain = (await call("find_definitions", { name: "Tx", exact: true })).definitions;
      assert.equal(plain[0].implementations, undefined);

      const callers = (await call("find_callers", { name: "Get" })).callers;
      assert.deepEqual(callers.map((row: any) => `${row.caller} ${row.line} -> ${row.targetClassName} ${row.targetFile}`), [
        "Load 12 -> Remote impl/remote.go",
        "Load 12 -> UserRepo repo/repo.go",
        "Load 15 -> PostRepo repo/repo.go",
      ]);
      const single = (await call("find_callers", { name: "Save" })).callers;
      assert.deepEqual(single.map((row: any) => [row.caller, row.targetClassName, row.targetFile, row.targetId]), [["save", undefined, undefined, undefined]]);
    } finally {
      await store.close();
    }
  });
});
