/**
 * Scan memory probe: live heap after each step of a scan, and the size of the
 * graph by node label and relationship type.
 *
 *   npm run probe:memory -- <project path> [--workers N] [--no-cache] [--cache-dir dir] [--json out.json]
 *   node --expose-gc --import tsx scripts/scan-memory-probe.ts <project path> ...
 *
 * For a large repository add `--max-old-space-size=<MB>` before the script
 * (the probe keeps the whole scan in memory, like a scan does). The probe
 * re-runs, in one process, the steps of `buildCodeGraph` (src/core/scan/
 * orchestrator.ts) and `scanIntoStore` (src/adapters/cli/scan.ts) one at a
 * time, using only their public functions. After each step it calls
 * `global.gc()` twice and records heapUsed and rss, so "live heap" is what the
 * step leaves behind, not what it allocated on the way; "peak heap" is the
 * highest heapUsed seen by a 50 ms sampler during the step, which only runs
 * while the event loop is free and so can miss short synchronous bursts.
 *
 * Results go into docs/benchmarks.md ("Scan memory (large repositories)").
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { nodeContentHasher, nodeFileSystem } from "../src/adapters/fs/node-file-system.js";
import { openGraphStore } from "../src/composition/graph-store.js";
import { coreIntegrationRegistry, defaultLanguageTable } from "../src/composition/default-registry.js";
import { parserFingerprint } from "../src/composition/parser-fingerprint.js";
import { createParserPool } from "../src/composition/parser-pool.js";
import { runWithConcurrency } from "../src/core/scan/concurrency.js";
import { discoverFiles } from "../src/core/scan/discover-files.js";
import { createScanManifest } from "../src/core/scan/manifest.js";
import { ParseCache } from "../src/adapters/fs/parse-cache.js";
import { OrderedParseResults } from "../src/core/scan/parse-results.js";
import { parseFileWithContext } from "../src/core/scan/parse-source.js";
import { addProjectConfigNodes } from "../src/core/scan/project-config.js";
import { loadProjectSettings } from "../src/core/scan/project-settings.js";
import { createScanReport } from "../src/core/scan/report.js";
import { filterSupportedSourceFiles } from "../src/core/scan/source-files.js";
import { addWorkspacePackageGraph } from "../src/core/scan/workspace-packages.js";
import { compactUnresolvedCalls } from "../src/core/scan/call-sites.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import type { ILanguageParser } from "../src/core/contracts/language-parser.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workers: { type: "string" },
    "no-cache": { type: "boolean", default: false },
    "cache-dir": { type: "string" },
    json: { type: "string" },
  },
});
const projectArgument = positionals[0];
if (!projectArgument) {
  console.error("usage: scan-memory-probe <project path> [--workers N] [--no-cache] [--cache-dir dir] [--json out.json]");
  process.exit(2);
}
if (typeof global.gc !== "function") {
  console.error("run with --expose-gc: node --expose-gc --import tsx scripts/scan-memory-probe.ts <project path>");
  process.exit(2);
}
const gc = global.gc;
const rootPath = path.resolve(projectArgument);
const mb = (bytes: number) => Math.round(bytes / 1048576);

type Step = { step: string; seconds: number; liveHeapMb: number; addedMb: number; peakHeapMb: number; heapBeforeGcMb: number; rssMb: number };
const steps: Step[] = [];
gc();
gc();
let previousLive = mb(process.memoryUsage().heapUsed);

// Runs one step, then records the live heap after two forced collections.
async function step<T>(name: string, action: () => Promise<T> | T): Promise<T> {
  let peak = process.memoryUsage().heapUsed;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 50);
  const start = process.hrtime.bigint();
  let result: T;
  try {
    result = await action();
  } finally {
    clearInterval(sampler);
  }
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  const before = process.memoryUsage().heapUsed;
  peak = Math.max(peak, before);
  gc();
  gc();
  const after = process.memoryUsage();
  const live = mb(after.heapUsed);
  const row: Step = { step: name, seconds: Math.round(seconds * 10) / 10, liveHeapMb: live, addedMb: live - previousLive, peakHeapMb: mb(peak), heapBeforeGcMb: mb(before), rssMb: mb(after.rss) };
  previousLive = live;
  steps.push(row);
  console.error(`  ${name}: ${row.seconds}s, live ${live} MB (${row.addedMb >= 0 ? "+" : ""}${row.addedMb})`);
  return result;
}

const hashFile = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

console.error(`Probing ${rootPath}`);
const registry = coreIntegrationRegistry;
const languages = defaultLanguageTable;
const settings = await loadProjectSettings(rootPath, languages, nodeFileSystem);

// 1. File discovery, language detection and the manifest (hash of every file).
const { supportedFiles, manifest, files } = await step("discover files + manifest", async () => {
  const discovered = await discoverFiles(rootPath, nodeFileSystem, {
    include: settings.include.length > 0 ? settings.include : undefined,
    exclude: settings.exclude.length > 0 ? settings.exclude : undefined,
    conventions: languages.conventions,
  });
  const supported = filterSupportedSourceFiles(discovered, undefined, languages, settings.extensions);
  return { supportedFiles: supported, manifest: await createScanManifest(rootPath, supported, nodeFileSystem, nodeContentHasher), files: discovered };
});
const codeFiles = supportedFiles.filter((file) => languages.isCode(file.language)).length;
const report = createScanReport(files.length, codeFiles, supportedFiles.length - codeFiles);
const repoNodeId = `repo:${rootPath}`;

const useCache = !values["no-cache"];
const cacheDirectory = values["cache-dir"] ? path.resolve(values["cache-dir"]) : path.join(os.tmpdir(), "concentrate-memory-probe-cache");
const cache = useCache ? new ParseCache(cacheDirectory, rootPath, await parserFingerprint(), report.parseCache) : null;
report.parseCache.enabled = cache !== null;
const contentHashes = new Map(manifest.files.map((file) => [file.path, file.hash]));
const languageOf = new Map(supportedFiles.map((file) => [file.filePath, file.language]));
const cacheKey = (filePath: string) => {
  const relativePath = path.relative(rootPath, filePath).split(path.sep).join(path.posix.sep);
  const contentHash = contentHashes.get(relativePath);
  const overridden = settings.extensions.has(path.extname(filePath).toLowerCase());
  return cache && contentHash ? { key: cache.key(relativePath, overridden ? `${contentHash}\0${languageOf.get(filePath)}` : contentHash), contentHash } : null;
};

// 2. Parse: cache reads, then workers for the misses. As in a scan, each
// result goes into the GraphBuilder (with its dedupe sets) once the results
// of the files before it are in.
let graph: GraphBuilder | null = new GraphBuilder();
await step("parse + add to graph (streamed)", async () => {
  graph!.addNode({ id: repoNodeId, label: "Repo", properties: { path: rootPath, name: path.basename(rootPath) } });
  await addProjectConfigNodes(graph!, repoNodeId, rootPath, report, nodeFileSystem, registry.projectManifestReaders);
  const results = new OrderedParseResults(graph!, repoNodeId, rootPath, report, true, languages);
  const misses: number[] = [];
  const concurrency = os.availableParallelism();
  await runWithConcurrency([...supportedFiles.keys()], concurrency, async (index) => {
    const entry = cacheKey(supportedFiles[index]!.filePath);
    const cached = entry ? await cache!.read(entry.key) : null;
    if (cached) results.set(index, { ok: true, parsed: cached, filePath: supportedFiles[index]!.filePath });
    else misses.push(index);
  });
  misses.sort((a, b) => a - b);
  const codeMisses = misses.filter((index) => languages.isCode(supportedFiles[index]!.language)).length;
  const requested = values.workers === undefined ? undefined : Number.parseInt(values.workers, 10);
  // Same default as a scan: up to 4 workers once there are 100 code files to parse.
  const workers = codeMisses === 0 ? 0 : requested ?? (codeMisses >= 100 ? Math.max(0, Math.min(4, os.availableParallelism() - 1)) : 0);
  report.parseWorkers = workers;
  const pool = workers > 0 ? createParserPool(workers) : null;
  try {
    await runWithConcurrency(misses, pool ? Math.max(concurrency, workers * 2) : concurrency, async (index) => {
      const { filePath, language } = supportedFiles[index]!;
      try {
        const parser: ILanguageParser = pool && languages.isCode(language)
          ? { language, parse: (root, file) => pool.parse(language, root, file) }
          : registry.getLanguageParser(language);
        const parsed = await parseFileWithContext(rootPath, filePath, language, parser);
        const entry = cacheKey(filePath);
        if (entry && await hashFile(filePath) === entry.contentHash) await cache!.write(entry.key, parsed);
        results.set(index, { ok: true, parsed, filePath });
      } catch (error) {
        results.set(index, { ok: false, error, filePath });
      }
    });
  } finally {
    await pool?.close();
  }
  console.error(`  (${codeFiles} code files, ${report.parseWorkers} workers, cache ${cache ? `${report.parseCache.hits} hits / ${report.parseCache.misses} misses` : "off"})`);
});

// 4. Workspace packages and the language resolvers.
await step(`workspace packages + ${registry.languageResolvers.length} resolvers`, async () => {
  await addWorkspacePackageGraph(graph!, repoNodeId, rootPath, report, nodeFileSystem, registry.projectManifestReaders);
  for (const resolver of registry.languageResolvers) await resolver.resolve(graph!, rootPath, report);
});

// 5. Semantic contributors.
await step(`${registry.semanticContributors.length} semantic contributors`, async () => {
  for (const contributor of registry.semanticContributors) {
    await contributor.contribute(graph!, rootPath, report, files, { apiOrigins: settings.apiOrigins });
  }
});

// 5b. Unresolved call sites become a property of their caller (as in buildCodeGraph).
await step("compact unresolved call sites", () => compactUnresolvedCalls(graph!));

// 6. What a scan keeps once it returns: only the node and relationship arrays.
let nodes: GraphNode[] | null = graph!.nodes;
let relationships: GraphRelationship[] | null = graph!.relationships;
graph = null;
await step("release builder (scan result only)", () => undefined);

// 7. The store write: scanIntoStore's `reset()` + `write()` into a temporary directory.
const workDirectory = await mkdtemp(path.join(os.tmpdir(), "concentrate-memory-probe-"));
const databasePath = path.join(workDirectory, "graph");
try {
  let writer: Awaited<ReturnType<typeof openGraphStore>> | null = await openGraphStore(databasePath);
  await step("store reset + write (store still open)", async () => {
    await writer!.reset();
    await writer!.write(nodes!, relationships!);
  });
  await writer.close();
  writer = null;
  await step("store closed", () => undefined);

  // The size of the graph by kind, from the scan result.
  const nodeSizes = tally(nodes!.map((node) => [node.label, JSON.stringify(node).length]));
  const relationshipSizes = tally(relationships!.map((relationship) => [relationship.type, JSON.stringify(relationship).length]));
  const counts = { nodes: nodes!.length, relationships: relationships!.length };
  nodes = null;
  relationships = null;
  await step("scan result dropped", () => undefined);

  // 8. The read path: a fresh store opened on the finished graph, then `stats()`.
  let reader: Awaited<ReturnType<typeof openGraphStore>> | null = null;
  await step("fresh openGraphStore (load snapshot)", async () => { reader = await openGraphStore(databasePath); });
  await step("stats()", () => reader!.stats());
  await reader!.close();

  const peakRssMb = mb(process.resourceUsage().maxRSS * 1024);
  printTables(counts, nodeSizes, relationshipSizes, peakRssMb);
  if (values.json) {
    const summary = { project: rootPath, node: process.version, files: files.length, codeFiles, workers: report.parseWorkers, cache: useCache, ...counts, peakRssMb, steps, nodeSizes, relationshipSizes };
    await writeFile(values.json, `${JSON.stringify(summary, null, 2)}\n`);
    console.error(`wrote ${values.json}`);
  }
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}

type Tally = Array<{ kind: string; items: number; jsonBytes: number }>;

function tally(entries: Array<[string, number]>): Tally {
  const byKind = new Map<string, { items: number; jsonBytes: number }>();
  for (const [kind, size] of entries) {
    const row = byKind.get(kind) ?? { items: 0, jsonBytes: 0 };
    row.items += 1;
    row.jsonBytes += size;
    byKind.set(kind, row);
  }
  return [...byKind].map(([kind, row]) => ({ kind, ...row })).sort((a, b) => b.jsonBytes - a.jsonBytes);
}

function printTables(counts: { nodes: number; relationships: number }, nodeSizes: Tally, relationshipSizes: Tally, peakRssMb: number): void {
  const pad = (value: string | number, width: number) => String(value).padStart(width);
  console.log(`\n${rootPath}: ${files.length} files (${codeFiles} code), ${counts.nodes} nodes, ${counts.relationships} relationships, ${report.parseWorkers} parse workers, cache ${useCache ? "on" : "off"}, Node ${process.version}`);
  console.log("\nLive heap after GC, per step (MB)\n");
  console.log(`${"Step".padEnd(52)}${pad("Time s", 8)}${pad("Live", 8)}${pad("Added", 8)}${pad("Peak", 8)}${pad("Before GC", 11)}${pad("RSS", 8)}`);
  for (const row of steps) {
    console.log(`${row.step.padEnd(52)}${pad(row.seconds, 8)}${pad(row.liveHeapMb, 8)}${pad(row.addedMb, 8)}${pad(row.peakHeapMb, 8)}${pad(row.heapBeforeGcMb, 11)}${pad(row.rssMb, 8)}`);
  }
  console.log(`\nPeak RSS of the probe process: ${peakRssMb} MB`);
  for (const [title, rows] of [["Nodes by label", nodeSizes], ["Relationships by type", relationshipSizes]] as const) {
    console.log(`\n${title} (JSON size = sum of JSON.stringify length of each record)\n`);
    console.log(`${"Kind".padEnd(28)}${pad("Items", 12)}${pad("JSON MB", 10)}${pad("Bytes/item", 12)}`);
    for (const row of rows) console.log(`${row.kind.padEnd(28)}${pad(row.items, 12)}${pad((row.jsonBytes / 1048576).toFixed(1), 10)}${pad(Math.round(row.jsonBytes / row.items), 12)}`);
  }
}
