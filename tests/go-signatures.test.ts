import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
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
      .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${byId.get(rel.to)!.properties.name}`)
      .sort();
    assert.deepEqual(implementations, ["PostRepo -> Posts", "UserRepo -> Users"]);
  });

  it("resolves calls in closures, on a closure's parameter and past a nested redeclaration", () => {
    const resolved = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.from.startsWith("file:main.go:"))
      .map((rel) => `${byId.get(rel.from)!.properties.line} ${byId.get(rel.from)!.properties.expression} -> ${byId.get(rel.to)!.properties.className ?? ""}.${byId.get(rel.to)!.properties.name}`)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
    assert.deepEqual(resolved, [
      "12 s.users.Get -> UserRepo.Get",
      "15 s.posts.Get -> PostRepo.Get",
      "25 repo.Run -> .Run",
      "26 tx.Save -> Tx.Save",
      "32 svc.Load -> Service.Load",
      "33 save -> .save",
    ]);
  });
});
