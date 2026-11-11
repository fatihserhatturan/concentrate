/**
 * Release report: scan time, peak memory and MCP tool latency of the built
 * CLI on the sample repositories.
 *
 *   npm run bench:release -- [--suite standing|internet|all] [--sample name…] [--runs 3]
 *     [--tool-runs 20] [--out file.json] [--baseline earlier.json]
 *     [--tolerance 1.15] [--min-delta 20]
 *
 * `npm run bench:release` builds first. Per sample:
 *   - cold scan: `concentrate scan --no-cache` in a child process, the median
 *     of `runs` runs, with its peak RSS (scripts/scan-probe.mjs);
 *   - warm scan: the same with the parse cache filled by a first run;
 *   - tool latency: p50 / p95 of every MCP tool over `tool-runs` calls after a
 *     warm-up, on the graph the scan wrote. Arguments come from the graph (the
 *     most-called function, its file, the first route, the first import).
 *
 * Writes bench/results/<version>-<date>.json unless --out names another file.
 * With --baseline, compares scan times, memory and tool p50s against an
 * earlier report and exits with 1 on a regression, as bench:parser does.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fileOfNodeId } from "./accuracy/compare.js";
import { availableSamples, checkRegression, measure, parseSuite, round, timing, type Timing } from "./bench-common.js";

const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "all" },
    sample: { type: "string", multiple: true },
    runs: { type: "string", default: "3" },
    "tool-runs": { type: "string", default: "20" },
    out: { type: "string" },
    baseline: { type: "string" },
    tolerance: { type: "string", default: "1.15" },
    "min-delta": { type: "string", default: "20" },
  },
});
const suite = parseSuite(values.suite);
const runs = Number.parseInt(values.runs!, 10);
const toolRuns = Number.parseInt(values["tool-runs"]!, 10);
const tolerance = Number.parseFloat(values.tolerance!);
const minDelta = Number.parseFloat(values["min-delta"]!);

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "dist/index.js");
const probe = path.join(root, "scripts/scan-probe.mjs");
// The built store and tools, so latency matches what the CLI serves.
const { openGraphStore } = await import(path.join(root, "dist/composition/graph-store.js")) as typeof import("../src/composition/graph-store.js");
const { callMcpTool, mcpToolDefinitions } = await import(path.join(root, "dist/adapters/mcp/tools.js")) as typeof import("../src/adapters/mcp/tools.js");
const packageVersion = (JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string }).version;

type ScanRun = { ms: number; maxRssMb: number };
type SampleResult = {
  sample: string;
  nodes: number;
  relationships: number;
  scanCold: ScanRun;
  scanWarm: ScanRun;
  tools: Record<string, Timing>;
};
type ReleaseReport = { version: string; recordedAt: string; node: string; platform: string; cpus: number; runs: number; toolRuns: number; results: SampleResult[] };

// A scan that skipped unparsable files exits with 1; samples marked
// continueOnError in the manifest are expected to.
async function scanOnce(projectPath: string, args: string[], allowPartial: boolean): Promise<ScanRun> {
  const probeOut = path.join(workRoot, `probe-${process.hrtime.bigint()}.json`);
  const ms = await measure(() => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", probe, cli, "scan", projectPath, ...args], {
      env: { ...process.env, CONCENTRATE_PROBE_OUT: probeOut },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 || (allowPartial && code === 1) ? resolve() : reject(new Error(`scan exited with ${code}: ${stderr.slice(-2000)}`))));
  }));
  const { maxRssKb } = JSON.parse(await readFile(probeOut, "utf8")) as { maxRssKb: number };
  return { ms: Math.round(ms), maxRssMb: Math.round(maxRssKb / 1024) };
}

// Median run by time; its peak RSS goes with it.
function medianRun(scans: ScanRun[]): ScanRun {
  return [...scans].sort((a, b) => a.ms - b.ms)[Math.floor(scans.length / 2)]!;
}

type Row = Record<string, unknown>;

// Tool arguments that hit real data in this graph.
async function toolCases(store: Awaited<ReturnType<typeof openGraphStore>>): Promise<Array<{ tool: string; args: Row }>> {
  const files = new Set((await store.query("MATCH (file:File) RETURN file.relativePath AS path") as Row[]).map((row) => String(row.path)));
  const callees = await store.query("MATCH (:Call)-[:CALL_RESOLVES_TO]->(fn:Function) RETURN id(fn) AS id, fn.name AS name") as Row[];
  const counts = new Map<string, { name: string; calls: number }>();
  for (const row of callees) {
    const entry = counts.get(String(row.id)) ?? { name: String(row.name), calls: 0 };
    entry.calls += 1;
    counts.set(String(row.id), entry);
  }
  const [topId, top] = [...counts].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))[0] ?? [];
  const routes = (await store.query(`
    MATCH (file:File)-[:DECLARES_ROUTE]->(route:Route) WHERE route.method <> 'USE'
    RETURN route.method AS method, route.fullPath AS fullPath, route.path AS path ORDER BY file.relativePath, route.line
  `) as Row[]).filter((row) => typeof (row.fullPath ?? row.path) === "string");
  const [edge] = await store.query(`
    MATCH (source:File)-[:IMPORTS]->(:Import)-[:RESOLVES_TO]->(target:File)
    RETURN source.relativePath AS source, target.relativePath AS target ORDER BY source.relativePath, target.relativePath
  `) as Row[];

  const [component] = await store.query(`MATCH (component:Component) RETURN component.name AS name ORDER BY component.name`) as Row[];

  const name = top?.name;
  const file = topId ? fileOfNodeId(topId, files) : null;
  const route = routes[0];
  const cases: Array<{ tool: string; args: Row | null }> = [
    { tool: "graph_stats", args: {} },
    { tool: "find_definitions", args: name ? { name } : null },
    { tool: "find_callers", args: name ? { name } : null },
    { tool: "list_exports", args: {} },
    { tool: "trace_import_chain", args: edge ? { from: edge.source, to: edge.target } : null },
    { tool: "list_routes", args: {} },
    { tool: "list_entrypoints", args: {} },
    { tool: "list_env_config", args: {} },
    { tool: "list_data_access", args: {} },
    { tool: "list_tables", args: {} },
    { tool: "list_rpcs", args: {} },
    { tool: "impact_of", args: name ? { symbol: name } : null },
    { tool: "detect_changes", args: {} },
    { tool: "route_details", args: route ? { method: route.method, path: route.fullPath ?? route.path } : null },
    { tool: "get_symbol_source", args: name ? { name } : null },
    { tool: "get_file_outline", args: file ? { file } : null },
    { tool: "search_symbols", args: name ? { query: name.slice(0, 4) } : null },
    { tool: "find_references", args: name ? { symbol: name } : null },
    { tool: "find_import_cycles", args: {} },
    { tool: "find_unused_exports", args: {} },
    { tool: "architecture_overview", args: {} },
    { tool: "list_pages", args: {} },
    { tool: "list_stores", args: {} },
    { tool: "api_consumers", args: route ? { method: route.method, path: route.fullPath ?? route.path } : {} },
    { tool: "component_tree", args: component ? { name: component.name } : null },
    { tool: "find_component_usages", args: component ? { name: component.name } : null },
  ];
  const missing = mcpToolDefinitions.map((tool) => tool.name).filter((tool) => !cases.some((entry) => entry.tool === tool));
  if (missing.length > 0) throw new Error(`No benchmark case for: ${missing.join(", ")}`);
  return cases.flatMap((entry) => (entry.args ? [{ tool: entry.tool, args: entry.args }] : []));
}

const workRoot = await mkdtemp(path.join(os.tmpdir(), "concentrate-release-"));
const results: SampleResult[] = [];
try {
  const only = values.sample ?? [];
  const samples = (await availableSamples(suite)).filter((sample) => only.length === 0 || only.includes(sample.name));
  if (samples.length === 0) throw new Error(`No fetched sample matches: ${only.join(", ")}`);
  for (const sample of samples) {
    const databasePath = path.join(workRoot, `${sample.name}-graph`);
    const cacheDir = path.join(workRoot, `${sample.name}-cache`);
    const common = ["-d", databasePath, "--manifest", path.join(workRoot, `${sample.name}-manifest.json`), "--cache-dir", cacheDir,
      ...(sample.continueOnError ? ["--continue-on-error"] : []), ...(sample.apiOrigins ?? []).flatMap((origin) => ["--api-origin", origin]), ...(sample.exclude ?? []).flatMap((pattern) => ["--exclude", pattern])];

    const partial = sample.continueOnError === true;
    const cold: ScanRun[] = [];
    for (let run = 0; run < runs; run += 1) cold.push(await scanOnce(sample.projectPath, [...common, "--no-cache"], partial));
    await scanOnce(sample.projectPath, common, partial); // fills the parse cache
    const warm: ScanRun[] = [];
    for (let run = 0; run < runs; run += 1) warm.push(await scanOnce(sample.projectPath, common, partial));

    const store = await openGraphStore(databasePath);
    try {
      const count = async (cypher: string) => Number((await store.query(cypher) as Row[])[0]?.count ?? 0);
      const stats = { nodes: await count("MATCH (n) RETURN count(n) AS count"), relationships: await count("MATCH ()-[r]->() RETURN count(r) AS count") };
      const tools: Record<string, Timing> = {};
      for (const { tool, args } of await toolCases(store)) {
        await callMcpTool(store, tool, args); // warm-up
        const times: number[] = [];
        for (let run = 0; run < toolRuns; run += 1) times.push(await measure(() => callMcpTool(store, tool, args)));
        tools[tool] = timing(times);
      }
      results.push({ sample: sample.name, nodes: stats.nodes, relationships: stats.relationships, scanCold: medianRun(cold), scanWarm: medianRun(warm), tools });
    } finally {
      await store.close();
    }
    console.error(`done ${sample.name}`);
  }
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

const recordedAt = new Date().toISOString();
const report: ReleaseReport = {
  version: packageVersion,
  recordedAt,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpus: os.availableParallelism(),
  runs,
  toolRuns,
  results,
};
const outPath = values.out ?? path.join(root, "bench/results", `${packageVersion}-${recordedAt.slice(0, 10)}.json`);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.error(`wrote ${outPath}`);

console.log(`### Scan (${report.platform}, Node ${report.node}, ${report.cpus} CPUs; median of ${runs})\n`);
console.log("| Sample | Nodes | Rels | Cold scan ms | Cold peak RSS MB | Warm scan ms | Warm peak RSS MB |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const result of results) {
  console.log(`| ${result.sample} | ${result.nodes} | ${result.relationships} | ${result.scanCold.ms} | ${result.scanCold.maxRssMb} | ${result.scanWarm.ms} | ${result.scanWarm.maxRssMb} |`);
}

const toolNames = mcpToolDefinitions.map((tool) => tool.name);
console.log(`\n### Tool latency, p50 / p95 ms (${toolRuns} calls)\n`);
console.log(`| Tool | ${results.map((result) => result.sample).join(" | ")} |`);
console.log(`| --- | ${results.map(() => "---:").join(" | ")} |`);
for (const tool of toolNames) {
  const cells = results.map((result) => (result.tools[tool] ? `${result.tools[tool].p50} / ${result.tools[tool].p95}` : "–"));
  console.log(`| ${tool} | ${cells.join(" | ")} |`);
}

if (values.baseline) {
  const baseline = JSON.parse(await readFile(values.baseline, "utf8")) as ReleaseReport;
  console.log(`\nBaseline ${values.baseline} (${baseline.version}, ${baseline.node}, ${baseline.platform}); tolerance ${tolerance}× and +${minDelta} ms / MB`);
  if (baseline.platform !== report.platform || baseline.node !== report.node) {
    console.log("Warning: the baseline was recorded on another platform or Node version; numbers may not be comparable.");
  }
  let regressions = 0;
  const ms = { tolerance, minDelta, unit: "ms" };
  for (const result of results) {
    const before = baseline.results.find((entry) => entry.sample === result.sample);
    if (!before) continue;
    const checks: Array<[string, number, number, typeof ms]> = [
      ["cold scan", before.scanCold.ms, result.scanCold.ms, ms],
      ["warm scan", before.scanWarm.ms, result.scanWarm.ms, ms],
      ["cold peak RSS", before.scanCold.maxRssMb, result.scanCold.maxRssMb, { ...ms, unit: "MB" }],
      // Tool calls take milliseconds: a +min-delta ms floor would hide every change.
      ...Object.entries(result.tools).flatMap(([tool, now]): Array<[string, number, number, typeof ms]> => (
        before.tools[tool] ? [[`${tool} p50`, before.tools[tool]!.p50, now.p50, { tolerance, minDelta: round(minDelta / 10), unit: "ms" }]] : []
      )),
    ];
    for (const [metric, then, now, options] of checks) {
      if (checkRegression(`${result.sample} ${metric}`, then, now, options)) regressions += 1;
    }
  }
  if (regressions > 0) process.exitCode = 1;
}
