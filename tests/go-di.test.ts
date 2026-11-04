import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

function injections(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "INJECTS")
    .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${byId.get(rel.to)!.properties.name} ${rel.properties.fieldName}`)
    .sort();
}

describe("Go dependency injection", () => {
  it("links fx providers to the structs their parameters take", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/go-fx"), { continueOnError: false });
    assert.deepEqual(injections(graph), [
      // fx.In fields.
      "Mailer -> AuditLog Audit",
      "Mailer -> Users Users",
      "Server -> Mailer mailer",
      "Server -> Users users",
      "Users -> AuditLog audit",
      // The interface fx.As binds to the provider's struct.
      "Users -> sqlUserStore users",
      // NewUserStore returns the interface: the bound struct is the consumer.
      "sqlUserStore -> Config cfg",
    ]);
    assert.ok(graph.nodes.every((node) => !("goDi" in node.properties)));

    const store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-go-di-")), "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const result = (await callMcpTool(store, "find_references", { symbol: "Users" })).structuredContent as Record<string, any>;
      const injectedBy = JSON.stringify(result);
      assert.match(injectedBy, /Server/u);
      assert.match(injectedBy, /Mailer/u);
    } finally {
      await store.close();
    }
  });

  it("links wire providers, wire.Struct fields and wire.Bind", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/go-wire"), { continueOnError: false });
    assert.deepEqual(injections(graph), [
      "App -> Handler h",
      // Two structs implement Clock; wire.Bind picks SystemClock.
      "Handler -> Orders Orders",
      "Handler -> SystemClock Clock",
      "Orders -> SystemClock clock",
    ]);
  });
});
