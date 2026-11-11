import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

// [kind, trigger, file:line, handlers]
function entrypoints(graph: Graph, kind: string): Array<[string, string, string, string[]]> {
  return graph.nodes
    .filter((node) => node.label === "EntryPoint" && node.properties.kind === kind)
    .map((entry) => {
      const file = graph.relationships.find((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.to === entry.id)!.from.slice("file:".length);
      const handlers = graph.relationships
        .filter((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)
        .map((rel) => String(graph.nodes.find((node) => node.id === rel.to)?.properties.name));
      return [kind, String(entry.properties.trigger), `${file}:${entry.properties.line}`, handlers] as [string, string, string, string[]];
    })
    .sort((a, b) => a[2].localeCompare(b[2], "en", { numeric: true }) || a[1].localeCompare(b[1]));
}

describe("Rust tonic entrypoints", () => {
  it("makes an EntryPoint per method of the served trait's implementation", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/rust-tonic"), { continueOnError: false });
    assert.deepEqual(entrypoints(graph, "grpc"), [
      // `GreeterServer::new(greeter)`: the type comes from the local's constructor.
      ["grpc", "Greeter/say_goodbye", "src/main.rs:17", ["say_goodbye"]],
      ["grpc", "Greeter/say_hello", "src/main.rs:17", ["say_hello"]],
      // `InventoryServer::from_arc(store)` with `store = Arc::new(StoreService::new())`.
      ["grpc", "Inventory/list_items", "src/main.rs:18", ["list_items"]],
    ]);
    assert.equal(graph.nodes.some((node) => node.label === "File" && node.properties.rustGrpcServers !== undefined), false);
  });
});

describe("Rust clap entrypoints", () => {
  it("reads derive commands through nested subcommands and their match arms", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/rust-clap"), { continueOnError: false });
    assert.deepEqual(entrypoints(graph, "cli").filter((entry) => entry[2].startsWith("src/main.rs")), [
      ["cli", "serve", "src/main.rs:17", ["serve"]],
      ["cli", "run-migrations", "src/main.rs:21", ["migrate"]],
      ["cli", "version-info", "src/main.rs:24", []],
      ["cli", "db reset", "src/main.rs:40", ["reset"]],
      ["cli", "db seed", "src/main.rs:41", ["seed"]],
    ]);
  });

  it("reads the builder's subcommands and the arms that dispatch them", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/rust-clap"), { continueOnError: false });
    assert.deepEqual(entrypoints(graph, "cli").filter((entry) => entry[2].startsWith("src/builder.rs")), [
      ["cli", "build", "src/builder.rs:5", ["build_project"]],
      ["cli", "clean", "src/builder.rs:6", ["clean_project"]],
    ]);
  });
});
