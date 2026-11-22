import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { assertGolden, goldenRoot, scanToGoldenText } from "./helpers/golden.js";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");
// Fixtures whose golden is recorded by a later wave of their phase.
const pendingGolden = new Set(["csharp-solution"]);
const fixtureNames = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !pendingGolden.has(entry.name))
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
