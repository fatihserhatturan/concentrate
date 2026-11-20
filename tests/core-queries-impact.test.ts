import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CypherError } from "../src/adapters/store/cypher/errors.js";
import type { IChangeSource } from "../src/core/contracts/change-source.js";
import { detectChanges, parseDiff } from "../src/core/queries/changes.js";
import { impactOf } from "../src/core/queries/impact.js";
import { isStyleFilePath, parseStyleSymbol } from "../src/core/queries/styles.js";
import { assertValidRevision } from "../src/adapters/git/change-source.js";

const emptyEngine = { query: async () => [] } as never;

test("parseDiff records new-side ranges and deleted files", () => {
  const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +3,2 @@", "@@ -9 +12,0 @@", "--- a/gone.ts", "+++ /dev/null"].join("\n");
  const parsed = parseDiff(diff);
  assert.deepEqual(parsed.get("x.ts"), [{ start: 3, end: 4 }, { start: 12, end: 12 }]);
  assert.deepEqual(parsed.get("gone.ts"), [{ start: 1, end: Number.POSITIVE_INFINITY }]);
});

test("detectChanges maps an injected change source onto scan paths", async () => {
  const source: IChangeSource = {
    changes: async () => ({ scanRoot: "/r/app", repoRoot: "/r", diff: "", untracked: ["app/new.ts", "other/skip.ts"] }),
  };
  const result = await detectChanges(emptyEngine, source, { scanPath: "/r/app", base: "HEAD", maxDepth: 3, limit: 10 });
  assert.deepEqual(result.unscannedFiles, ["new.ts"]);
  assert.equal(result.impact, null);
});

test("impactOf needs a symbol or file; style helpers", async () => {
  await assert.rejects(impactOf(emptyEngine, { maxDepth: 2, window: { offset: 0, limit: 5 } }), /needs a symbol or a file/);
  assert.equal(parseStyleSymbol(".btn")?.name, "btn");
  assert.equal(isStyleFilePath("a/b.scss"), true);
  assert.throws(() => assertValidRevision("--evil"));
});

test("loadInterfaceMethods is empty only for a store without the Java relationship table; other errors surface", async () => {
  const { loadInterfaceMethods } = await import("../src/core/queries/graph.js");
  const missing = { query: async () => { throw new CypherError("binder", "Table DEFINES_INTERFACE_METHOD does not exist."); } } as never;
  assert.deepEqual(await loadInterfaceMethods(missing), []);
  const broken = { query: async () => { throw new Error("disk read failed"); } } as never;
  await assert.rejects(loadInterfaceMethods(broken), /disk read failed/);
  const otherTable = { query: async () => { throw new CypherError("binder", "Table Interface does not exist."); } } as never;
  await assert.rejects(loadInterfaceMethods(otherTable), /Table Interface does not exist/);
});

test("impact_of works on a non-Java graph, with and without the Java schema extension", async () => {
  const { buildCodeGraph } = await import("../src/composition/orchestrator.js");
  const { GraphStore } = await import("../src/adapters/store/store.js");
  const { baseGraphSchema } = await import("../src/core/graph/schema.js");
  const { openTestStore } = await import("./helpers/store.js");
  const graph = await buildCodeGraph(path.resolve("fixtures/go-basic"), { continueOnError: false });
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-impact-nonjava-"));
  try {
    const stores = [
      await openTestStore(path.join(dir, "default")),
      await GraphStore.open(path.join(dir, "base"), { schema: baseGraphSchema }),
    ];
    for (const store of stores) {
      await store.reset();
      await store.write(graph.nodes.filter((node) => baseGraphSchema.nodeTables.some((table) => table.label === node.label)), graph.relationships.filter((rel) => baseGraphSchema.relationshipTables.some((table) => table.type === rel.type)));
      const result = await impactOf(store, { symbol: "Run", maxDepth: 2, window: { offset: 0, limit: 5 } });
      assert.equal(result.seeds.length, 1);
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
