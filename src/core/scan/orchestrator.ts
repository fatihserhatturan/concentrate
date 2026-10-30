import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import { runWithConcurrency } from "./concurrency.js";
import { discoverFiles } from "./discover-files.js";
import { finalizeGraphRelationships } from "./graph-finalize.js";
import { parseFileWithContext, type ParseResult } from "./parse-source.js";
import { addParseResultsToGraph } from "./parse-results.js";
import { addProjectConfigNodes } from "./project-config.js";
import { createScanManifest, type ScanManifest } from "./manifest.js";
import { ParseCache } from "./parse-cache.js";
import { filterSupportedSourceFiles } from "./source-files.js";
import { addWorkspacePackageGraph } from "./workspace-packages.js";
import type { IScanOrchestrator } from "../contracts/scan-orchestrator.js";
import type { ILanguageParser } from "../contracts/language-parser.js";
import type { IParserPool } from "../contracts/parser-pool.js";
import type { ILanguageResolver } from "../contracts/language-resolver.js";
import type { ISemanticContributor } from "../contracts/semantic-contributor.js";
import type { ScanReport } from "./report.js";
import { createScanReport } from "./report.js";
import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "./result.js";

export interface ScanDependencies {
  getParser: (language: string) => ILanguageParser;
  resolvers: readonly ILanguageResolver[];
  contributors: readonly ISemanticContributor[];
  // Identifies the parser code; required for the parse cache (options.cacheDirectory).
  parserFingerprint?: () => Promise<string>;
  // Starts worker threads that parse files; without it every file is parsed
  // on the main thread (see options.workers).
  createParserPool?: (size: number) => IParserPool;
  // Whether options.workers unset may start workers; false keeps that case on
  // the main thread (an explicit count still starts them).
  autoParseWorkers?: boolean;
}

// Below this many files to parse, starting workers costs more than it saves.
export const AUTO_WORKERS_MIN_FILES = 100;
const AUTO_WORKERS_MAX = 4;

// Worker threads to parse `fileCount` files with: the requested count, or
// automatically up to AUTO_WORKERS_MAX (leaving a core for the main thread)
// once there are AUTO_WORKERS_MIN_FILES files. Zero parses on the main thread.
export function parseWorkerCount(requested: number | undefined, fileCount: number, auto = true): number {
  if (fileCount === 0) return 0;
  if (requested !== undefined) return Math.max(0, Math.trunc(requested));
  if (!auto || fileCount < AUTO_WORKERS_MIN_FILES) return 0;
  const count = Math.min(AUTO_WORKERS_MAX, os.availableParallelism() - 1);
  return count >= 2 ? count : 0;
}

export function createScanOrchestrator(deps: ScanDependencies): IScanOrchestrator {
  return { buildGraph: (projectPath, options) => buildCodeGraph(projectPath, options, deps) };
}

export async function buildCodeGraph(
  projectPath: string,
  options: BuildCodeGraphOptions,
  deps: ScanDependencies,
): Promise<BuildCodeGraphResult> {
  const rootPath = path.resolve(projectPath);
  const repoNodeId = `repo:${rootPath}`;
  const files = await discoverFiles(rootPath, {
    include: options.include,
    exclude: options.exclude,
  });

  const supportedFiles = filterSupportedSourceFiles(files, options.maxFiles);
  const manifest = await createScanManifest(rootPath, supportedFiles);

  const graph = new GraphBuilder();
  const report = createScanReport(files.length, supportedFiles.length);
  const cache = options.cacheDirectory && deps.parserFingerprint
    ? new ParseCache(options.cacheDirectory, rootPath, await deps.parserFingerprint(), report.parseCache)
    : null;
  report.parseCache.enabled = cache !== null;
  const contentHashes = new Map(manifest.files.map((file) => [file.path, file.hash]));
  const concurrency = options.concurrency ?? os.availableParallelism();

  graph.addNode({
    id: repoNodeId,
    label: "Repo",
    properties: {
      path: rootPath,
      name: path.basename(rootPath),
    },
  });
  await addProjectConfigNodes(graph, repoNodeId, rootPath, report);

  let progressCount = 0;
  const progress = (filePath: string) =>
    options.onProgress?.(++progressCount, supportedFiles.length, path.relative(rootPath, filePath));
  const cacheKey = (filePath: string) => {
    const relativePath = path.relative(rootPath, filePath).split(path.sep).join(path.posix.sep);
    const contentHash = contentHashes.get(relativePath);
    return cache && contentHash ? { key: cache.key(relativePath, contentHash), contentHash } : null;
  };

  // Pass 1: parse results the cache already has.
  const parseResults: ParseResult[] = new Array(supportedFiles.length);
  const misses: number[] = [];
  await runWithConcurrency([...supportedFiles.keys()], concurrency, async (index) => {
    const { filePath } = supportedFiles[index]!;
    const entry = cacheKey(filePath);
    const cached = entry ? await cache!.read(entry.key) : null;
    if (cached) {
      progress(filePath);
      parseResults[index] = { ok: true, parsed: cached, filePath };
    } else {
      misses.push(index);
    }
  });
  misses.sort((a, b) => a - b);

  // Pass 2: parse the rest, on worker threads when there are enough of them.
  const workers = deps.createParserPool ? parseWorkerCount(options.workers, misses.length, deps.autoParseWorkers ?? true) : 0;
  const pool = workers > 0 ? deps.createParserPool!(workers) : null;
  report.parseWorkers = workers;
  try {
    await runWithConcurrency(misses, pool ? Math.max(concurrency, workers * 2) : concurrency, async (index) => {
      const { filePath, language } = supportedFiles[index]!;
      progress(filePath);
      try {
        const parser: ILanguageParser = pool
          ? { language, parse: (root, file) => pool.parse(language, root, file) }
          : deps.getParser(language);
        const parsed = await parseFileWithContext(rootPath, filePath, language, parser);
        // Store before the scan adds to the result, and only if the file still
        // has the content the manifest hashed (it may change during the scan).
        const entry = cacheKey(filePath);
        if (entry && await hashFile(filePath) === entry.contentHash) await cache!.write(entry.key, parsed);
        parseResults[index] = { ok: true, parsed, filePath };
      } catch (error) {
        parseResults[index] = { ok: false, error, filePath };
      }
    });
  } finally {
    await pool?.close();
  }

  const parsedFully = addParseResultsToGraph(
    graph,
    repoNodeId,
    rootPath,
    parseResults,
    report,
    options.continueOnError,
  );
  if (!parsedFully) {
    report.status = "failed";
    return createResult(rootPath, graph, report, manifest);
  }

  await cache?.prune();
  await addWorkspacePackageGraph(graph, repoNodeId, rootPath, report);
  await finalizeGraphRelationships(graph, rootPath, report, deps.resolvers, deps.contributors, files, { apiOrigins: options.apiOrigins ?? [] });
  report.status = report.failedFiles.length > 0 ? "partial" : "success";

  return createResult(rootPath, graph, report, manifest);
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function createResult(
  rootPath: string,
  graph: GraphBuilder,
  report: ScanReport,
  manifest: ScanManifest,
): BuildCodeGraphResult {
  return {
    rootPath,
    nodes: graph.nodes,
    relationships: graph.relationships,
    report,
    manifest,
  };
}
