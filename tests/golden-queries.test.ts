import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { openGraphStore } from "../src/composition/graph-store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { ROOT_PLACEHOLDER } from "../src/core/graph/normalize.js";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { readSampleManifest, samplesDirectory } from "../src/adapters/cli/smoke.js";
import { assertGolden, goldenRoot, isPlaceholderFixture } from "./helpers/golden.js";
import { cypherTemplate, RecordingQueryEngine } from "./helpers/recording-engine.js";

type QueryCase = { tool: string; args: Record<string, unknown> };
type QueryCases = { common: QueryCase[]; fixtures: Record<string, QueryCase[]> };

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");
const cases = JSON.parse(await readFile(path.join(goldenRoot, "query-cases.json"), "utf8")) as QueryCases;
const workRoot = await mkdtemp(path.join(os.tmpdir(), "concentrate-golden-queries-"));
const templates = new Set<string>();
const standingSamples = (await readSampleManifest()).filter((sample) => sample.suite === "standing");

after(() => rm(workRoot, { recursive: true, force: true }));

/** Scan a project into a fresh store and record every MCP case against it. */
async function recordCases(name: string, projectPath: string, projectCases: QueryCase[]): Promise<string> {
  const graph = await buildCodeGraph(projectPath, { continueOnError: true, concurrency: 4 });
  const store = await openGraphStore(path.join(workRoot, `${name}.graph`));
  try {
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
    const recorded = [];
    for (const testCase of projectCases) {
      const engine = new RecordingQueryEngine(store);
      const result = await callMcpTool(engine, testCase.tool, testCase.args);
      for (const call of engine.calls) {
        if (call.method === "query") templates.add(cypherTemplate(call.cypher));
      }
      recorded.push({ ...testCase, calls: engine.calls, output: JSON.parse(result.content[0]!.text) as unknown });
    }
    return `${JSON.stringify(recorded, null, 2).replaceAll(graph.rootPath, ROOT_PLACEHOLDER)}\n`;
  } finally {
    await store.close();
  }
}

describe("golden MCP query recordings", () => {
  for (const [name, extra] of Object.entries(cases.fixtures)) {
    // A placeholder fixture (README only: a Phase 47 track has not filled it yet) has no recording.
    it(name, { skip: isPlaceholderFixture(path.join(fixturesRoot, name)) ? "placeholder fixture" : false }, async () => {
      const actual = await recordCases(name, path.join(fixturesRoot, name), [...cases.common, ...extra]);
      await assertGolden(path.join(goldenRoot, "queries", `${name}.json`), actual);
    });
  }

  for (const sample of standingSamples) {
    const projectPath = path.join(samplesDirectory(), sample.name);
    const skip = existsSync(projectPath) || process.env.REQUIRE_SAMPLES === "1"
      ? false
      : `sample missing at ${projectPath}; run \`npm run samples:fetch\``;
    it(`sample: ${sample.name}`, { skip }, async () => {
      const actual = await recordCases(sample.name, projectPath, cases.common);
      await assertGolden(path.join(goldenRoot, "queries", "samples", `${sample.name}.json.gz`), actual);
    });
  }
});

describe("golden MCP query shapes", () => {
  // Pins the set of distinct query shapes the MCP tools issue, so a new tool or
  // filter that is not covered by query-cases.json shows up as a golden diff.
  it("covers every MCP query shape", async () => {
    assert.ok(templates.size > 0);
    await assertGolden(path.join(goldenRoot, "queries", "templates.json"), `${JSON.stringify([...templates].sort(), null, 2)}\n`);
  });
});
