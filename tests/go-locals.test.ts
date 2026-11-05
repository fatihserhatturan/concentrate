import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

describe("Go calls on package variables and ranges over call results", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-locals"), { continueOnError: false });
  });

  it("resolves each call in main to its method", () => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const resolved = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.from.startsWith("file:main.go:"))
      .map((rel) => `${byId.get(rel.from)!.properties.line} ${byId.get(rel.from)!.properties.expression} -> ${byId.get(rel.to)!.properties.className}.${byId.get(rel.to)!.properties.name}`)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
    assert.deepEqual(resolved, [
      "14 local.All -> Store.All",
      "15 config.DB.Get -> Store.Get",
      "16 config.Default.All -> Store.All",
      "18 local.Get -> Store.Get",
      "18 local.Get(\"b\").Label -> Item.Label",
      "21 local.All -> Store.All",
      "22 item.Label -> Item.Label",
      "24 config.DB.ByName -> Store.ByName",
      "26 entry.Label -> Item.Label",
    ]);
  });

  it("keeps a package variable's type or constructor", () => {
    const variables = graph.nodes
      .filter((node) => node.label === "Variable")
      .map((node) => `${node.properties.name} ${node.properties.goType ?? ""}${node.properties.goConstructor ?? ""}`)
      .sort();
    assert.deepEqual(variables, ["DB store.New", "Default *store.Store", "local store.New"]);
  });
});
