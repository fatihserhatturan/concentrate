import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GraphBuilder, hashRelationship } from "../src/core/graph/builder.js";
import type { GraphRelationship } from "../src/core/graph/model.js";

function rel(from: string, to: string, properties: GraphRelationship["properties"] = {}): GraphRelationship {
  return { from, to, type: "CALLS", properties };
}

describe("GraphBuilder relationships", () => {
  it("drops exact duplicates and keeps the first one in insertion order", () => {
    const builder = new GraphBuilder();
    const first = rel("a", "b", { line: 1 });
    builder.addRelationships([first, rel("a", "c"), rel("a", "b", { line: 1 })]);
    assert.equal(builder.relationships.length, 2);
    assert.equal(builder.relationships[0], first);
    assert.equal(builder.relationships[1]?.to, "c");
  });

  it("keeps relationships with different properties or types", () => {
    const builder = new GraphBuilder();
    builder.addRelationships([
      rel("a", "b", { line: 1 }),
      rel("a", "b", { line: 2 }),
      { ...rel("a", "b", { line: 1 }), type: "IMPORTS_PACKAGE" },
    ]);
    assert.equal(builder.relationships.length, 3);
  });

  it("compares properties key-order sensitive and ignores undefined, like JSON.stringify", () => {
    const builder = new GraphBuilder();
    builder.addRelationships([
      rel("a", "b", { x: 1, y: 2 }),
      rel("a", "b", { y: 2, x: 1 }),
      rel("a", "b", { x: 1, y: 2 }),
      rel("c", "d", { x: 1 }),
      rel("c", "d", { x: 1, y: undefined }),
    ]);
    assert.equal(builder.relationships.length, 3);
  });

  it("does not merge endpoints that only collide when concatenated", () => {
    const builder = new GraphBuilder();
    builder.addRelationships([rel("a:CALLS:b", "c"), rel("a", "b:CALLS:c")]);
    assert.equal(builder.relationships.length, 2);
    assert.notEqual(hashRelationship(rel("ab", "c")), hashRelationship(rel("a", "bc")));
  });

  it("handles forced hash collisions", () => {
    const builder = new GraphBuilder(() => 7);
    builder.addRelationships([
      rel("a", "b"),
      rel("c", "d"),
      rel("a", "b"),
      rel("c", "d"),
      rel("e", "f"),
      rel("a", "b", { n: 1 }),
      rel("a", "b", { n: 1 }),
    ]);
    assert.deepEqual(
      builder.relationships.map((r) => `${r.from}>${r.to}:${JSON.stringify(r.properties)}`),
      ["a>b:{}", "c>d:{}", "e>f:{}", 'a>b:{"n":1}'],
    );
  });
});
