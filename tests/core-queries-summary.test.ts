import assert from "node:assert/strict";
import test from "node:test";
import type { IQueryEngine } from "../src/core/contracts/query-engine.js";
import { graphSummary } from "../src/core/queries/summary.js";
import { architectureOverview } from "../src/core/queries/architecture.js";

const empty = { schemaVersion: async () => 1, stats: async () => ({}), query: async () => [] } as unknown as IQueryEngine;

test("core summary and architecture run over an empty engine", async () => {
  const summary = await graphSummary(empty);
  assert.deepEqual(summary.files, { total: 0, code: 0, tests: 0 });
  const overview = await architectureOverview(empty, { level: "directory", depth: 2 });
  assert.equal(overview.level, "directory");
  assert.deepEqual(overview.edges, []);
});
