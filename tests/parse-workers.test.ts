import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { readSampleManifest, samplesDirectory } from "../src/adapters/cli/smoke.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { createParserPool } from "../src/composition/parser-pool.js";
import { coreIntegrationRegistry } from "../src/composition/default-registry.js";
import { AUTO_WORKERS_MIN_FILES, parseWorkerCount } from "../src/core/scan/orchestrator.js";
import { renderGolden } from "./helpers/golden.js";

describe("parse workers", () => {
  it("picks a worker count from the request and the number of files to parse", () => {
    assert.equal(parseWorkerCount(undefined, 0), 0);
    assert.equal(parseWorkerCount(undefined, AUTO_WORKERS_MIN_FILES - 1), 0);
    const auto = parseWorkerCount(undefined, AUTO_WORKERS_MIN_FILES);
    assert.equal(auto, Math.min(4, os.availableParallelism() - 1) >= 2 ? Math.min(4, os.availableParallelism() - 1) : 0);
    assert.equal(parseWorkerCount(undefined, 5000, false), 0, "auto off");
    assert.equal(parseWorkerCount(3, 1), 3, "an explicit count wins");
    assert.equal(parseWorkerCount(0, 5000), 0);
    assert.equal(parseWorkerCount(-2, 5000), 0);
    assert.equal(parseWorkerCount(2, 0), 0, "nothing to parse");
  });

  it("produces the same graph and failures as parsing on the main thread", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-workers-"));
    await mkdir(path.join(root, "src"));
    for (let index = 0; index < 12; index += 1) {
      await writeFile(
        path.join(root, "src", `module${index}.ts`),
        `import { helper } from './module${(index + 1) % 12}';\nexport function run${index}() {\n  return helper() + process.env.PORT_${index};\n}\nexport const helper = () => ${index};\n`,
      );
    }
    await writeFile(path.join(root, "src", "util.py"), "def greet(name):\n    return name\n");
    await writeFile(path.join(root, "src", "partial.ts"), "export function partial( {\n");
    await writeFile(path.join(root, "src", "broken.py"), "def broken(:\n");

    const mainThread = await buildCodeGraph(root, { continueOnError: true, workers: 0 });
    const workers = await buildCodeGraph(root, { continueOnError: true, workers: 2 });
    assert.equal(mainThread.report.parseWorkers, 0);
    assert.equal(workers.report.parseWorkers, 2);
    assert.equal(workers.report.failedFiles.length, 1);
    assert.equal(workers.report.warnings.length, 1);
    assert.equal(renderGolden(workers), renderGolden(mainThread));
  });

  it("matches the main thread on the express sample", { skip: existsSync(path.join(samplesDirectory(), "express")) ? false : "sample missing; run `npm run samples:fetch`" }, async () => {
    const sample = (await readSampleManifest()).find((entry) => entry.name === "express")!;
    const projectPath = path.join(samplesDirectory(), sample.name);
    const options = { continueOnError: true, exclude: sample.exclude };
    const [mainThread, workers] = await Promise.all([
      buildCodeGraph(projectPath, { ...options, workers: 0 }),
      buildCodeGraph(projectPath, { ...options, workers: 3 }),
    ]);
    assert.equal(workers.report.parseWorkers, 3);
    assert.equal(renderGolden(workers), renderGolden(mainThread));
  });

  it("parses on the main thread when workers die", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-workers-dead-"));
    const crashing = path.join(root, "crash.mjs");
    await writeFile(crashing, "process.exit(3);\n");
    const file = path.join(root, "a.ts");
    await writeFile(file, "export function a() { return 1; }\n");

    const pool = createParserPool(2, pathToFileURL(crashing));
    try {
      const parsed = await Promise.all([pool.parse("typescript", root, file), pool.parse("typescript", root, file)]);
      const expected = await coreIntegrationRegistry.getLanguageParser("typescript").parse(root, file);
      for (const result of parsed) assert.deepEqual(result, expected);
      // Once every worker is gone, new files go straight to the main thread.
      assert.deepEqual(await pool.parse("typescript", root, file), expected);
    } finally {
      await pool.close();
    }
  });
});
