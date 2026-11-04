import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { readSampleManifest, samplesDirectory } from "../src/adapters/cli/smoke.js";
import { assertGolden, goldenRoot, scanToGoldenText } from "./helpers/golden.js";

// Sample repositories are fetched on demand (`npm run samples:fetch`), so plain
// `npm test` skips them. `npm run test:samples` sets REQUIRE_SAMPLES=1 and fails instead.
const requireSamples = process.env.REQUIRE_SAMPLES === "1";
const samples = (await readSampleManifest()).filter((sample) => sample.suite === "standing" || sample.golden === true);

describe("golden sample graphs", () => {
  for (const sample of samples) {
    const projectPath = path.join(samplesDirectory(), sample.name);
    const present = existsSync(projectPath);
    const skip = !present && !requireSamples ? `sample missing at ${projectPath}; run \`npm run samples:fetch\`` : false;

    it(sample.name, { skip }, async () => {
      assert.ok(present, `Sample ${sample.name} is missing at ${projectPath}; run \`npm run samples:fetch\``);
      const actual = await scanToGoldenText(projectPath, {
        continueOnError: sample.continueOnError ?? true,
        exclude: sample.exclude,
        apiOrigins: sample.apiOrigins,
      });
      await assertGolden(path.join(goldenRoot, "samples", `${sample.name}.jsonl.gz`), actual);
    });
  }
});
