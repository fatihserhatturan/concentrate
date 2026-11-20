/**
 * Parser benchmark: where scan time goes on the sample repositories.
 *
 *   npm run bench:parser -- [--runs 5] [--suite standing|internet|all]
 *     [--json out.json] [--baseline before.json] [--tolerance 1.15] [--min-delta 20]
 *
 * `npm run bench:parser` builds first and measures dist/ (--dist).
 *
 * Per sample, each a median over `runs` runs after one warm-up, in one process
 * on one thread:
 *   - parse:   tree-sitter only (sources read beforehand, trees freed)
 *   - extract: the language parsers (read + parse + extraction), what a scan
 *              runs once per file
 *   - scan:    a full scan without the parse cache (all files, resolvers,
 *              semantic contributors) with the default parse workers
 *              (none from sources, see --dist)
 *   - scan (main thread): the same scan with `workers: 0`
 *
 * With --baseline, compares against an earlier --json run and exits with 1
 * when any sample's parse or scan median is more than `tolerance` times the
 * baseline and at least `min-delta` ms slower (so a 5 → 6 ms wobble on a
 * small sample is not a regression). Record the baseline on the same machine just before changing
 * grammars (see docs/benchmarks.md, "Grammar upgrades").
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { GrammarName } from "../src/integrations/languages/syntax/tree-sitter.js";
import { availableSamples, checkRegression, median as medianOf, parseSuite } from "./bench-common.js";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    suite: { type: "string", default: "all" },
    json: { type: "string" },
    baseline: { type: "string" },
    tolerance: { type: "string", default: "1.15" },
    "min-delta": { type: "string", default: "20" },
    dist: { type: "boolean", default: false },
  },
});

// --dist measures the build (`npm run build`), as installed users run it.
// From sources, parse workers only start when asked for and each one
// compiles the TypeScript sources again, so worker timings mean little there.
const code = values.dist ? "../dist" : "../src";
const { coreIntegrationRegistry, defaultLanguageTable } = await import(`${code}/composition/default-registry.js`) as typeof import("../src/composition/default-registry.js");
const { buildCodeGraph } = await import(`${code}/composition/orchestrator.js`) as typeof import("../src/composition/orchestrator.js");
const { discoverFiles } = await import(`${code}/core/scan/discover-files.js`) as typeof import("../src/core/scan/discover-files.js");
const { filterSupportedSourceFiles } = await import(`${code}/core/scan/source-files.js`) as typeof import("../src/core/scan/source-files.js");
const { parseSyntaxTree } = await import(`${code}/integrations/languages/syntax/tree-sitter.js`) as typeof import("../src/integrations/languages/syntax/tree-sitter.js");
const runs = Number.parseInt(values.runs!, 10);
const tolerance = Number.parseFloat(values.tolerance!);
const minDelta = Number.parseFloat(values["min-delta"]!);
const suite = parseSuite(values.suite);

type SampleResult = {
  sample: string;
  files: number;
  bytes: number;
  parseMs: number;
  extractMs: number;
  scanMs: number;
  scanMainThreadMs: number;
  workers: number;
  failedFiles: number;
};
type BenchReport = { code: string; node: string; platform: string; grammars: Record<string, string>; runs: number; results: SampleResult[] };

const median = (action: () => Promise<unknown>) => medianOf(action, runs);

const grammarManifest = JSON.parse(await readFile(new URL("../vendor/grammars/manifest.json", import.meta.url), "utf8")) as {
  cli: string;
  grammars: Record<string, { version: string; sha256: string }>;
};
const grammars = Object.fromEntries(
  Object.entries(grammarManifest.grammars).map(([name, grammar]) => [name, `${grammar.version} (${grammar.sha256.slice(0, 8)})`]),
);

const results: SampleResult[] = [];
for (const sample of await availableSamples(suite)) {
  const { projectPath } = sample;
  const files = filterSupportedSourceFiles(await discoverFiles(projectPath, { exclude: sample.exclude, conventions: defaultLanguageTable.conventions }), undefined, defaultLanguageTable);
  const sources = await Promise.all(files.map(async (file) => ({ ...file, source: await readFile(file.filePath, "utf8") })));

  const parseMs = await median(async () => {
    for (const { language, source } of sources) {
      try {
        (await parseSyntaxTree(language as GrammarName, source)).delete();
      } catch {
        // Counted as failed by the extract phase.
      }
    }
  });

  let failedFiles = 0;
  const extractMs = await median(async () => {
    failedFiles = 0;
    for (const { language, filePath } of files) {
      try {
        await coreIntegrationRegistry.getLanguageParser(language).parse(projectPath, filePath);
      } catch {
        failedFiles += 1;
      }
    }
  });

  let workers = 0;
  const scanMs = await median(async () => {
    workers = (await buildCodeGraph(projectPath, { continueOnError: true, exclude: sample.exclude })).report.parseWorkers;
  });
  const scanMainThreadMs = await median(() => buildCodeGraph(projectPath, { continueOnError: true, exclude: sample.exclude, workers: 0 }));

  results.push({
    sample: sample.name,
    files: files.length,
    bytes: sources.reduce((total, { source }) => total + Buffer.byteLength(source), 0),
    parseMs,
    extractMs,
    scanMs,
    scanMainThreadMs,
    workers,
    failedFiles,
  });
  console.error(`done ${sample.name}`);
}

const report: BenchReport = { code: values.dist ? "dist" : "src", node: process.version, platform: `${process.platform}-${process.arch}`, grammars, runs, results };
if (values.json) await writeFile(values.json, `${JSON.stringify(report, null, 2)}\n`);

const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-");
console.log("| Sample | Files | KB | Parse ms | Extract ms | Scan ms, main thread | Extract / scan | Scan ms (workers) |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const result of results) {
  console.log(
    `| ${result.sample} | ${result.files} | ${Math.round(result.bytes / 1024)} | ${result.parseMs} | ${result.extractMs} | ` +
      `${result.scanMainThreadMs} | ${share(result.extractMs, result.scanMainThreadMs)} | ${result.scanMs} (${result.workers}) |`,
  );
}

if (values.baseline) {
  const baseline = JSON.parse(await readFile(values.baseline, "utf8")) as BenchReport;
  const changed = Object.keys({ ...baseline.grammars, ...grammars }).filter((name) => baseline.grammars[name] !== grammars[name]);
  console.log(`\nBaseline ${values.baseline} (${baseline.node}, ${baseline.platform}); tolerance ${tolerance}× and +${minDelta} ms`);
  if (changed.length > 0) {
    console.log(`Grammars changed: ${changed.map((name) => `${name} ${baseline.grammars[name] ?? "-"} → ${grammars[name] ?? "-"}`).join(", ")}`);
  }
  if (baseline.platform !== report.platform || baseline.node !== report.node) {
    console.log("Warning: the baseline was recorded on another platform or Node version; timings may not be comparable.");
  }
  let regressions = 0;
  for (const result of results) {
    const before = baseline.results.find((entry) => entry.sample === result.sample);
    if (!before) continue;
    for (const metric of ["parseMs", "scanMainThreadMs", "scanMs"] as const) {
      if (before[metric] === undefined) continue;
      if (checkRegression(`${result.sample} ${metric}`, before[metric], result[metric], { tolerance, minDelta, unit: "ms" })) regressions += 1;
    }
  }
  if (regressions > 0) process.exitCode = 1;
}

