import assert from "node:assert/strict";
import test from "node:test";
import { checkCycles, checkVerdict } from "../src/core/queries/check.js";
import type { ImportCyclesResult } from "../src/core/queries/cycles.js";
import { matchName } from "../src/core/queries/match.js";

const cycle = (typeOnly: boolean) => ({ size: 2, members: ["a", "b"], cycle: ["a", "b", "a"], typeOnly });
const result = (scope: "file" | "package"): ImportCyclesResult => ({ scope, cycles: [cycle(false), cycle(true)], ids: {} });

test("checkVerdict exceeds only above max", () => {
  assert.equal(checkVerdict(0).exceeded, false);
  assert.equal(checkVerdict(1).exceeded, true);
  assert.equal(checkVerdict(3, 3).exceeded, false);
});

test("checkCycles discounts type-only cycles unless included", () => {
  assert.equal(checkCycles(result("file")).count, 1);
  assert.equal(checkCycles(result("file"), { includeTypeOnly: true }).count, 2);
  assert.equal(checkCycles(result("package")).count, 2);
  assert.equal(checkCycles(result("file"), { includeTypeOnly: true, limit: 1 }).listed.length, 1);
});

test("matchName ranks exact above prefix", () => {
  assert.equal(matchName("foo", "foo")?.match, "exact");
  assert.equal(matchName("foobar", "foo")?.match, "prefix");
  assert.equal(matchName("abc", "xyz"), null);
});
