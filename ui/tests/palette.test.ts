import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { neighbour, type Placed } from "../web/src/graph/layout.js";
import { rankCommands, scoreCommand, type Command } from "../web/src/lib/commands.js";

const command = (id: string, title: string, group = "Go to", keywords?: string): Command => ({ id, title, group, keywords, run: () => {} });

describe("command matching", () => {
  it("ranks exact, prefix, substring, keyword and letter-order matches in that order", () => {
    const list = [command("a", "Open Routes"), command("b", "Routes"), command("c", "Go to Routes view"), command("d", "Tables", "Go to", "database routes"), command("e", "Rescan the project")];
    // "Open Routes" and "Go to Routes view" both match at a word start: equal scores, then alphabetical.
    assert.deepEqual(rankCommands(list, "routes").map((c) => c.id), ["b", "c", "a", "d"]);
    assert.equal(scoreCommand(command("x", "Show keyboard shortcuts"), "ksc"), 1);
    assert.equal(scoreCommand(command("x", "Fit"), "zzz"), null);
  });

  it("matches several words in any order and treats an empty query as everything", () => {
    assert.ok(scoreCommand(command("x", "Trace path from the focused node"), "node path")! > 0);
    assert.equal(scoreCommand(command("x", "Anything"), "   "), 0);
    const list = [command("b", "B", "Graph"), command("a", "A", "Go to")];
    assert.deepEqual(rankCommands(list, "").map((c) => c.id), ["b", "a"], "keeps the group order of registration");
  });
});

describe("arrow navigation", () => {
  const box = (x: number, y: number): Placed => ({ x, y, width: 100, height: 40 });
  // two users on the left, the centre, two things it uses on the right
  const nodes = new Map<string, Placed>([["u1", box(0, 0)], ["u2", box(0, 60)], ["c", box(200, 30)], ["d1", box(400, 0)], ["d2", box(400, 60)]]);

  it("moves across columns to the nearest node and along a column", () => {
    assert.equal(neighbour(nodes, "c", "right"), "d1", "a tie goes to the lower id");
    assert.equal(neighbour(nodes, "c", "left"), "u1");
    assert.equal(neighbour(nodes, "d1", "down"), "d2");
    assert.equal(neighbour(nodes, "d2", "up"), "d1");
    assert.equal(neighbour(nodes, "d1", "left"), "c");
  });

  it("stays where it is at an edge and ignores unknown nodes", () => {
    assert.equal(neighbour(nodes, "d1", "right"), null);
    assert.equal(neighbour(nodes, "u1", "up"), null);
    assert.equal(neighbour(nodes, "nope", "left"), null);
  });

  it("prefers a node straight across to one far above", () => {
    const more = new Map(nodes).set("far", box(0, -300));
    assert.equal(neighbour(more, "c", "left"), "u1");
  });
});
