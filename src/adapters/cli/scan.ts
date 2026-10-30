import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { printScanReport } from "./report.js";
import { ProgressReporter } from "./progress.js";
import { didFailFast, didPartiallySucceed, type BuildCodeGraphResult } from "../../core/scan/index.js";
import { scanOrchestrator } from "../../composition/orchestrator.js";
import { openGraphStore } from "../../composition/graph-store.js";

export type ScanAdapterOptions = {
  database: string;
  continueOnError: boolean;
  concurrency?: number;
  workers?: number;
  maxFiles?: number;
  include: string[];
  exclude: string[];
  apiOrigin?: string[];
  retryLock: boolean;
  cacheDir: string;
  cache?: boolean;
  manifest: string;
};

export type CliAdapterResult = {
  exitCode: number;
};

export async function runScanAdapter(projectPath: string, options: ScanAdapterOptions): Promise<CliAdapterResult> {
  const databasePath = path.resolve(options.database);
  const manifestPath = path.resolve(options.manifest);
  const progress = new ProgressReporter();

  const result = await scanIntoStore(projectPath, options, (current, total, relativePath) => {
    progress.update(current, total, relativePath);
  });
  progress.clear();

  printScanReport(result.report, result.nodes.length, result.relationships.length, databasePath);
  console.log(`  Manifest:        ${manifestPath}`);
  return { exitCode: didFailFast(result) || didPartiallySucceed(result) ? 1 : 0 };
}

// Scans the project and, unless the scan failed fast, rewrites the store with
// the whole graph. The manifest is written either way. Shared by scan and watch.
export async function scanIntoStore(
  projectPath: string,
  options: ScanAdapterOptions,
  onProgress?: (current: number, total: number, relativePath: string) => void,
): Promise<BuildCodeGraphResult> {
  const result = await scanOrchestrator.buildGraph(projectPath, {
    continueOnError: options.continueOnError,
    concurrency: options.concurrency,
    workers: options.workers,
    maxFiles: options.maxFiles,
    include: options.include.length > 0 ? options.include : undefined,
    exclude: options.exclude.length > 0 ? options.exclude : undefined,
    apiOrigins: options.apiOrigin,
    cacheDirectory: options.cache === false ? undefined : path.resolve(options.cacheDir),
    onProgress,
  });

  if (!didFailFast(result)) {
    const writer = await openGraphStore(path.resolve(options.database), { retryLock: options.retryLock !== false });
    try {
      // Always the whole graph: cross-file results (resolved calls, route paths)
      // can change in files that did not, and writing everything takes milliseconds.
      await writer.reset();
      await writer.write(result.nodes, result.relationships);
    } finally {
      await writer.close();
    }
  }

  await writeManifest(path.resolve(options.manifest), result.manifest);
  return result;
}

async function writeManifest(manifestPath: string, manifest: unknown): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
