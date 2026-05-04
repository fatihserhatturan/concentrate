import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runSmokeValidation, type SmokeSample } from "../src/commands/smoke.js";
import { SCHEMA_VERSION } from "../src/adapters/kuzu/schema.js";

describe("smoke validation", () => {
  it("runs scan, writes Kuzu, checks expected counts, and writes a report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-smoke-"));
    const projectPath = path.join(root, "project");
    const databasePath = path.join(root, "graph.kuzu");
    const reportPath = path.join(root, "smoke-report.json");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      path.join(projectPath, "index.ts"),
      "export function hello(): string {\n  return 'hello';\n}\n",
      "utf8",
    );

    const sample: SmokeSample = {
      name: "fixture",
      suite: "standing",
      projectPath,
      databasePath,
      expected: {
        discoveredFiles: 1,
        supportedFiles: 1,
        parsedFiles: 1,
        failedFiles: 0,
        resolvedImports: 0,
        unresolvedRelativeImports: 0,
        nodes: 4,
        relationships: 3,
        fileClassifications: {
          production: 1,
          test: 0,
          fixture: 0,
          support: 0,
          generated: 0,
        },
        graph: {
          schemaVersion: SCHEMA_VERSION,
          routes: 0,
          envVars: 0,
          configValues: 0,
          dataModels: 0,
        },
      },
    };

    const report = await runSmokeValidation([sample], {
      allowMissing: false,
      reportPath,
      incrementalBenchmark: true,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.results[0]?.status, "passed");
    assert.deepEqual(report.results[0]?.failures, []);

    assert.ok(report.results[0]?.semanticSamples);
    assert.equal(report.results[0]?.incrementalBenchmark?.status, "passed");
    assert.equal(report.results[0]?.incrementalBenchmark?.incremental.compatible, true);
    assert.equal(report.results[0]?.incrementalBenchmark?.graphPatch.effectiveMode, "patch");
    assert.equal(report.results[0]?.incrementalBenchmark?.graphPatch.affectedFiles, 0);
    assert.deepEqual(report.results[0]?.semanticSamples?.review, {
      falsePositiveFindings: [],
      falseNegativeFindings: [],
      notes: [],
    });

    const saved = JSON.parse(await readFile(reportPath, "utf8")) as {
      status?: string;
      results?: Array<{ semanticSamples?: unknown }>;
    };
    assert.equal(saved.status, "passed");
    assert.ok(saved.results?.[0]?.semanticSamples);
    assert.ok(saved.results?.[0]?.incrementalBenchmark);
  });
});
