import assert from "node:assert/strict";
import test from "node:test";
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
