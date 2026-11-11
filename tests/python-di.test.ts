import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

describe("Python dependency injection", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/python-di"), { continueOnError: false });
  });

  it("makes INJECTS from dependency-injector providers and FastAPI Depends providers", () => {
    const name = (id: string) => String(graph.nodes.find((node) => node.id === id)!.properties.name);
    const injects = graph.relationships
      .filter((rel) => rel.type === "INJECTS")
      .map((rel) => `${name(rel.from)} ${name(rel.to)} ${rel.properties.fieldName}`)
      .sort();
    assert.deepEqual(injects, [
      // A Callable provider builds the class its return annotation names.
      "Mailer Database db",
      // Positional arguments are named after the provider, keywords after the keyword, inline providers count.
      "OrderService Mailer mail",
      "OrderService Repository extra",
      "OrderService Repository repository",
      // A class whose __init__ takes Depends(...), a provider that builds the class it returns.
      "Report Db db",
      "Report UserService service",
      "Repository Database db",
      "UserRepo Db db",
      "UserService UserRepo repo",
    ]);
    // A route handler that only takes `Depends` is not a provider: its return annotation builds nothing.
    assert.ok(!injects.some((row) => row.startsWith("list ") || row.startsWith("dict ")));
  });
});
