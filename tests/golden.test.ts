import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { assertGolden, goldenRoot, scanToGoldenText } from "./helpers/golden.js";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");
const fixtureNames = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  // A fixture directory holding nothing but a README.md is a pending placeholder (Phase 46 wave 0): no golden until it has sources.
  .filter((entry) => readdirSync(path.join(fixturesRoot, entry.name)).some((file) => file !== "README.md"))
  .map((entry) => entry.name)
  .sort();

describe("golden fixture graphs", () => {
  for (const name of fixtureNames) {
    it(name, async () => {
      const actual = await scanToGoldenText(path.join(fixturesRoot, name));
      await assertGolden(path.join(goldenRoot, "fixtures", `${name}.jsonl`), actual);
    });
  }
});
