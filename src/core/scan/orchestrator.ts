import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import { runWithConcurrency } from "./concurrency.js";
import { discoverFiles } from "./discover-files.js";
import { compactUnresolvedCalls } from "./call-sites.js";
import { finalizeGraphRelationships } from "./graph-finalize.js";
import { parseFileWithContext } from "./parse-source.js";
import { OrderedParseResults } from "./parse-results.js";
import { addProjectConfigNodes } from "./project-config.js";
import { createScanManifest, type ScanManifest } from "./manifest.js";
import { filterSupportedSourceFiles } from "./source-files.js";
import type { LanguageTable } from "./language.js";
import { addWorkspacePackageGraph } from "./workspace-packages.js";
import type { IScanOrchestrator } from "../contracts/scan-orchestrator.js";
import type { ILanguageParser } from "../contracts/language-parser.js";
import type { IParserPool } from "../contracts/parser-pool.js";
import type { IParseCache } from "../contracts/parse-cache.js";
import type { IContentHasher, IFileSystem } from "../contracts/file-system.js";
import type { IProjectManifestReader } from "../contracts/project-manifest.js";
import type { ILanguageResolver } from "../contracts/language-resolver.js";
import type { ISemanticContributor } from "../contracts/semantic-contributor.js";
import type { ParseCacheReport, ScanReport } from "./report.js";
import { createScanReport } from "./report.js";
import { loadProjectSettings } from "./project-settings.js";
import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "./result.js";

export interface ScanDependencies {
  // Read access to the project, and the hash of its files' contents.
  fileSystem: IFileSystem;
  hasher: IContentHasher;
  // The languages of the scan: what a file is written in, and which languages are parsed as code.
  languages: LanguageTable;
  getParser: (language: string) => ILanguageParser;
  resolvers: readonly ILanguageResolver[];
  contributors: readonly ISemanticContributor[];
  // The manifests of the project's ecosystems: the packages and config values they declare.
  manifestReaders?: readonly IProjectManifestReader[];
  // Identifies the parser code; required for the parse cache (options.cacheDirectory).
  parserFingerprint?: () => Promise<string>;
  // Starts worker threads that parse files; without it every file is parsed
  // on the main thread (see options.workers).
  createParserPool?: (size: number) => IParserPool;
  // Whether options.workers unset may start workers; false keeps that case on
  // the main thread (an explicit count still starts them).
  autoParseWorkers?: boolean;
  // Called between the steps of a scan, where the previous step's working
  // data has just become garbage; may run a garbage collection.
  collectGarbage?: () => void;
  // Opens the disk cache of parse results, used only when options.cacheDirectory
  // and parserFingerprint are both set. Counts into `report`.
  createParseCache?: (cacheDirectory: string, rootPath: string, fingerprint: string, report: ParseCacheReport) => IParseCache;
  // How many tasks the machine runs at once (CPU count). Sets the default
  // options.concurrency and the automatic worker count. When absent the scan
  // assumes 1: files are parsed one at a time on the main thread unless the
  // caller asks for concurrency or workers explicitly.
  parallelism?: number;
}

// Below this many files to parse, starting workers costs more than it saves.
export const AUTO_WORKERS_MIN_FILES = 100;
const AUTO_WORKERS_MAX = 4;

// Worker threads to parse `fileCount` files with: the requested count, or
// automatically up to AUTO_WORKERS_MAX (leaving a core for the main thread)
// once there are AUTO_WORKERS_MIN_FILES files. Zero parses on the main thread.
export function parseWorkerCount(requested: number | undefined, fileCount: number, auto = true, parallelism = 1): number {
  if (fileCount === 0) return 0;
  if (requested !== undefined) return Math.max(0, Math.trunc(requested));
  if (!auto || fileCount < AUTO_WORKERS_MIN_FILES) return 0;
  const count = Math.min(AUTO_WORKERS_MAX, parallelism - 1);
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
  // concentrate.json: the command line's `--include` replaces its include list;
  // excludes and API origins are added to the file's.
  const settings = await loadProjectSettings(rootPath, deps.languages, deps.fileSystem);
  const include = options.include && options.include.length > 0 ? options.include : settings.include;
  const exclude = [...settings.exclude, ...options.exclude ?? []];
  const apiOrigins = [...settings.apiOrigins, ...options.apiOrigins ?? []];
  const files = await discoverFiles(rootPath, deps.fileSystem, {
    include: include.length > 0 ? include : undefined,
    exclude: exclude.length > 0 ? exclude : undefined,
    conventions: deps.languages.conventions,
  });

  const supportedFiles = filterSupportedSourceFiles(files, options.maxFiles, deps.languages, settings.extensions);
  const manifest = await createScanManifest(rootPath, supportedFiles, deps.fileSystem, deps.hasher);

  const graph = new GraphBuilder();
  const codeFiles = supportedFiles.filter((file) => deps.languages.isCode(file.language)).length;
  const report = createScanReport(files.length, codeFiles, supportedFiles.length - codeFiles);
  const cache = options.cacheDirectory && deps.parserFingerprint && deps.createParseCache
    ? deps.createParseCache(options.cacheDirectory, rootPath, await deps.parserFingerprint(), report.parseCache)
    : null;
  report.parseCache.enabled = cache !== null;
  const contentHashes = new Map(manifest.files.map((file) => [file.path, file.hash]));
  const concurrency = options.concurrency ?? deps.parallelism ?? 1;

  graph.addNode({
    id: repoNodeId,
    label: "Repo",
    properties: {
      path: rootPath,
      name: path.basename(rootPath),
      ...(settings.deprioritize.length > 0 ? { deprioritize: JSON.stringify(settings.deprioritize) } : {}),
    },
  });
  await addProjectConfigNodes(graph, repoNodeId, rootPath, report, deps.fileSystem, deps.manifestReaders);

  let progressCount = 0;
  const progress = (filePath: string) =>
    options.onProgress?.(++progressCount, supportedFiles.length, path.relative(rootPath, filePath));
  const languageOf = new Map(supportedFiles.map((file) => [file.filePath, file.language]));
  const cacheKey = (filePath: string) => {
    const relativePath = path.relative(rootPath, filePath).split(path.sep).join(path.posix.sep);
    const contentHash = contentHashes.get(relativePath);
    // A language chosen in concentrate.json is part of the key: the same content read as another language is another parse.
    const overridden = settings.extensions.has(path.extname(filePath).toLowerCase());
    return cache && contentHash ? { key: cache.key(relativePath, overridden ? `${contentHash}\0${languageOf.get(filePath)}` : contentHash), contentHash } : null;
  };

  // Each result goes into the graph as soon as the results of the files
  // before it are in, so the scan does not hold a result per file.
  const parseResults = new OrderedParseResults(graph, repoNodeId, rootPath, report, options.continueOnError, deps.languages);

  // Pass 1: parse results the cache already has.
  const misses: number[] = [];
  await runWithConcurrency([...supportedFiles.keys()], concurrency, async (index) => {
    const { filePath } = supportedFiles[index]!;
    const entry = cacheKey(filePath);
    const cached = entry ? await cache!.read(entry.key) : null;
    if (cached) {
      progress(filePath);
      parseResults.set(index, { ok: true, parsed: cached, filePath });
    } else {
      misses.push(index);
    }
  });
  misses.sort((a, b) => a - b);

  // Pass 2: parse the rest, on worker threads when there are enough code
  // files among them (the other files only become `File` nodes).
  const codeMisses = misses.filter((index) => deps.languages.isCode(supportedFiles[index]!.language)).length;
  const workers = deps.createParserPool ? parseWorkerCount(options.workers, codeMisses, deps.autoParseWorkers ?? true, deps.parallelism) : 0;
  const pool = workers > 0 ? deps.createParserPool!(workers) : null;
  report.parseWorkers = workers;
  try {
    await runWithConcurrency(misses, pool ? Math.max(concurrency, workers * 2) : concurrency, async (index) => {
      const { filePath, language } = supportedFiles[index]!;
      progress(filePath);
      try {
        const parser: ILanguageParser = pool && deps.languages.isCode(language)
          ? { language, parse: (root, file) => pool.parse(language, root, file) }
          : deps.getParser(language);
        const parsed = await parseFileWithContext(rootPath, filePath, language, parser);
        // Store before the scan adds to the result, and only if the file still
        // has the content the manifest hashed (it may change during the scan).
        const entry = cacheKey(filePath);
        if (entry && await hashFile(filePath, deps) === entry.contentHash) await cache!.write(entry.key, parsed);
        parseResults.set(index, { ok: true, parsed, filePath });
      } catch (error) {
        parseResults.set(index, { ok: false, error, filePath });
      }
    });
  } finally {
    await pool?.close();
  }

  if (!parseResults.complete) {
    report.status = "failed";
    return createResult(rootPath, graph, report, manifest);
  }

  await cache?.prune();
  deps.collectGarbage?.();
  await addWorkspacePackageGraph(graph, repoNodeId, rootPath, report, deps.fileSystem, deps.manifestReaders);
  await finalizeGraphRelationships(graph, rootPath, report, deps.resolvers, deps.contributors, files, { apiOrigins }, deps.collectGarbage);
  if (!options.keepCallSites) compactUnresolvedCalls(graph);
  report.status = report.failedFiles.length > 0 ? "partial" : "success";

  return createResult(rootPath, graph, report, manifest);
}

async function hashFile(filePath: string, deps: Pick<ScanDependencies, "fileSystem" | "hasher">): Promise<string> {
  return deps.hasher.hash(await deps.fileSystem.readFile(filePath));
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
