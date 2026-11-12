import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATEGORIES, DEFAULT_ENABLED, categoryOfKind, kindsOf, parseEnabled } from "../web/src/graph/categories.js";
import { edgeId, layeredLayout, nodeWidth } from "../web/src/graph/layout.js";
import { EDGE_KINDS } from "../server/graph/kinds.js";

const nodes = ["center", "a", "b", "c", "d"].map((id) => ({ id, name: id }));
// a and b use the center, the center uses c, c uses d.
const edges = [{ from: "a", to: "center" }, { from: "b", to: "center" }, { from: "center", to: "c" }, { from: "c", to: "d" }];

describe("layered layout", () => {
  it("puts what uses a node to its left and what it uses to its right", () => {
    const { nodes: placed } = layeredLayout(nodes, edges);
    const x = (id: string) => placed.get(id)!.x;
    assert.ok(x("a") < x("center") && x("b") < x("center"), "users on the left");
    assert.ok(x("center") < x("c") && x("c") < x("d"), "what it uses on the right, in order");
    assert.equal(x("a"), x("b"), "siblings share a column");
  });

  it("is the same picture for the same graph, whatever order it is given in", () => {
    const one = layeredLayout(nodes, edges);
    const two = layeredLayout([...nodes].reverse(), [...edges].reverse());
    assert.deepEqual([...one.nodes], [...two.nodes].sort(([a], [b]) => [...one.nodes.keys()].indexOf(a) - [...one.nodes.keys()].indexOf(b)));
    assert.deepEqual(one.width, two.width);
    assert.deepEqual([...one.edges.get(edgeId("a", "center"))!], [...two.edges.get(edgeId("a", "center"))!]);
  });

  it("gives every edge a route and survives cycles, self loops and duplicates", () => {
    const layout = layeredLayout(nodes, [...edges, { from: "d", to: "center" }, { from: "a", to: "a" }, { from: "a", to: "center" }]);
    assert.ok(layout.edges.get(edgeId("a", "center"))!.length >= 2);
    assert.equal(layout.edges.has(edgeId("a", "a")), false);
    assert.ok(layout.width > 0 && layout.height > 0);
  });

  it("sizes a node by its text within limits", () => {
    assert.equal(nodeWidth("a"), 150);
    assert.equal(nodeWidth("x".repeat(200)), 320);
    assert.ok(nodeWidth("a-reasonably-long-name.ts", "packages/core/a-reasonably-long-name.ts:12") > 150);
  });
});

describe("relationship categories", () => {
  it("cover every kind the server produces, and there are five", () => {
    assert.equal(CATEGORIES.length, 5);
    for (const kind of [...EDGE_KINDS, "defines"]) assert.ok(CATEGORIES.some((c) => c.kinds.includes(kind)), `${kind} has a category`);
    assert.equal(categoryOfKind("routes").id, "web");
    assert.equal(categoryOfKind("unheard-of").id, "calls");
  });

  it("start with structure switched off, and round-trip through the URL", () => {
    assert.deepEqual([...parseEnabled(undefined)], DEFAULT_ENABLED);
    assert.deepEqual([...parseEnabled("imports,structure")].sort(), ["imports", "structure"]);
    assert.deepEqual([...parseEnabled("")], []);
    assert.deepEqual([...parseEnabled("imports,bogus")], ["imports"]);
    assert.deepEqual(kindsOf(["structure"]), ["defines"]);
  });
});
