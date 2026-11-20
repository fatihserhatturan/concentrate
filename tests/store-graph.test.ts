import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { MemoryGraph } from "../src/adapters/store/graph.js";
import { defaultGraphSchemaIndex } from "../src/composition/default-schema.js";
import { serializeSegments } from "../src/adapters/store/persistence.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");

function canonical(graph: MemoryGraph): string {
  return [...serializeSegments(graph)].map(([key, content]) => `# ${key}\n${content}`).join("");
}

function fileNode(relativePath: string): GraphNode {
  return { id: `file:${relativePath}`, label: "File", properties: { relativePath, language: "typescript" } } as GraphNode;
}

function functionNode(file: string, name: string): GraphNode {
  return { id: `file:${file}:function:1:${name}`, label: "Function", properties: { name, line: 1 } } as GraphNode;
}

function defines(file: string, name: string): GraphRelationship {
  return { from: `file:${file}`, to: `file:${file}:function:1:${name}`, type: "DEFINES_FUNCTION", properties: {} } as GraphRelationship;
}

describe("MemoryGraph", () => {
  it("validates writes against the schema", () => {
    const graph = new MemoryGraph(defaultGraphSchemaIndex);
    assert.throws(() => graph.addNode("NoSuchLabel", "x", {}), /table NoSuchLabel does not exist/);
    assert.throws(() => graph.addNode("File", "f", { noSuchProperty: 1 }), /unknown property noSuchProperty/);
    assert.throws(() => graph.addNode("File", "f", { isTest: "yes" }), /must be BOOLEAN/);
    graph.addNode("File", "f", { relativePath: "a.ts" });
    assert.throws(() => graph.addNode("File", "f", {}), /duplicate primary key/);
    graph.addNode("Function", "fn", { name: "a" });
    assert.throws(() => graph.addRelationship("DEFINES_FUNCTION", "fn", "f", {}), /expected File -> Function/);
    assert.equal(graph.addRelationship("DEFINES_FUNCTION", "f", "missing", {}), false);
    assert.equal(graph.addRelationship("DEFINES_FUNCTION", "f", "fn", {}), true);
    assert.equal(graph.relationshipCount, 1);
  });

  it("detach-deletes nodes, including self-loops", () => {
    const graph = new MemoryGraph(defaultGraphSchemaIndex);
    graph.addNode("Class", "a", { name: "A" });
    graph.addNode("Class", "b", { name: "B" });
    graph.addRelationship("EXTENDS", "a", "a", {});
    graph.addRelationship("EXTENDS", "a", "b", {});
    graph.addRelationship("EXTENDS", "b", "a", {});
    graph.deleteNode(graph.node("a")!);
    assert.equal(graph.nodeCount, 1);
    assert.equal(graph.relationshipCount, 0);
    assert.deepEqual(graph.node("b")!.outgoing, []);
    assert.deepEqual(graph.node("b")!.incoming, []);
    assert.equal(graph.lookup("Class", "name", "A")!.size, 0);
  });

  it("indexes name, relativePath, method and path", () => {
    const graph = new MemoryGraph(defaultGraphSchemaIndex);
    graph.addNode("Function", "f1", { name: "run" });
    graph.addNode("Function", "f2", { name: "run" });
    graph.addNode("Class", "c1", { name: "run" });
    assert.equal(graph.lookup("Function", "name", "run")!.size, 2);
    assert.equal(graph.lookup("Class", "name", "run")!.size, 1);
    assert.equal(graph.lookup("Function", "line", 1), undefined);
  });
});
