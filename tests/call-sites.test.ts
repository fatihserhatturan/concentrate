import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { unresolvedCalls } from "../src/core/queries/graph.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

const fixture = path.resolve("fixtures/call-graph");
const workRoot = await mkdtemp(path.join(os.tmpdir(), "concentrate-call-sites-"));
after(() => rm(workRoot, { recursive: true, force: true }));

describe("unresolved call sites", () => {
  it("are properties of their caller, not nodes, and resolved calls stay nodes", async () => {
    const full = await buildCodeGraph(fixture, { continueOnError: false, keepCallSites: true });
    const compact = await buildCodeGraph(fixture, { continueOnError: false });

    const resolvedOnly = (nodes: typeof full.nodes, relationships: typeof full.relationships) => {
      const resolved = new Set(relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO").map((rel) => rel.from));
      return nodes.filter((node) => node.label === "Call" && resolved.has(node.id)).map((node) => node.id).sort();
    };
    assert.deepEqual(resolvedOnly(compact.nodes, compact.relationships), resolvedOnly(full.nodes, full.relationships));

    const removed = full.nodes.filter((node) => node.label === "Call").length - compact.nodes.filter((node) => node.label === "Call").length;
    assert.ok(removed > 0, "the fixture has unresolved calls");

    // Every removed call is in its caller's property, sorted by line.
    let recorded = 0;
    for (const node of compact.nodes) {
      if (typeof node.properties.unresolvedCalls !== "string") continue;
      const sites = JSON.parse(node.properties.unresolvedCalls) as Array<[string, number, string]>;
      recorded += sites.length;
      assert.deepEqual(sites.map((site) => site[1]), sites.map((site) => site[1]).sort((a, b) => a - b));
      for (const site of sites) assert.equal(site.length, 3);
    }
    assert.equal(recorded, removed);
    for (const rel of compact.relationships) {
      if (rel.type === "CALLS" || rel.type === "MODULE_CALLS") assert.ok(compact.nodes.some((node) => node.id === rel.to));
    }
  });

  it("are still reported by unresolvedCalls()", async () => {
    const full = await buildCodeGraph(fixture, { continueOnError: false, keepCallSites: true });
    const compact = await buildCodeGraph(fixture, { continueOnError: false });
    const names = [...new Set(full.nodes.filter((node) => node.label === "Call").map((node) => String(node.properties.callee)))];

    const answers = [];
    for (const [index, graph] of [full, compact].entries()) {
      const store = await GraphStore.open(path.join(workRoot, `g${index}`));
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      answers.push(await unresolvedCalls(store, names));
    }
    assert.ok(answers[0]!.count > 0);
    assert.equal(answers[1]!.count, answers[0]!.count);
    assert.deepEqual(answers[1]!.sites, answers[0]!.sites);
  });
});
