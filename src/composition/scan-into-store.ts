import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { didFailFast, type BuildCodeGraphResult } from "../core/scan/index.js";
import type { ScanDependencies } from "../core/scan/orchestrator.js";
import { CoreIntegrationRegistry } from "../core/integrations/registry.js";
import type { GraphSchema } from "../core/graph/schema.js";
import { buildCodeGraph } from "./orchestrator.js";
import { openGraphStore } from "./graph-store.js";
import { collectGarbageAfterGrowth } from "./garbage.js";

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

export type ScanIntoStoreOptions = ScanAdapterOptions & {
  /** The store's tables; defaults to the scanner registry's schema, else the default one. */
  graphSchema?: GraphSchema;
};

export type ScanProgressHook = (current: number, total: number, relativePath: string) => void;

// Scans the project and, unless the scan failed fast, rewrites the store with
// the whole graph. The manifest is written either way. Reporting is left to the
// caller through onProgress. Shared by scan, watch and the UI. `scanner`
// replaces the default registry for this scan: another registry or the
// dependencies made by createScanDependencies.
export async function scanIntoStore(
  projectPath: string,
  options: ScanIntoStoreOptions,
  onProgress?: ScanProgressHook,
  scanner?: CoreIntegrationRegistry | ScanDependencies,
): Promise<BuildCodeGraphResult> {
  const result = await buildCodeGraph(projectPath, {
    continueOnError: options.continueOnError,
    concurrency: options.concurrency,
    workers: options.workers,
    maxFiles: options.maxFiles,
    include: options.include.length > 0 ? options.include : undefined,
    exclude: options.exclude.length > 0 ? options.exclude : undefined,
    apiOrigins: options.apiOrigin,
    cacheDirectory: options.cache === false ? undefined : path.resolve(options.cacheDir),
    onProgress,
  }, scanner);

  if (!didFailFast(result)) {
    const writer = await openGraphStore(path.resolve(options.database), {
      retryLock: options.retryLock !== false,
      schema: options.graphSchema ?? (scanner instanceof CoreIntegrationRegistry ? scanner.graphSchema : undefined),
    });
    try {
      // Always the whole graph: cross-file results (resolved calls, route paths)
      // can change in files that did not, and writing everything takes milliseconds.
      await writer.reset();
      // The scan's GraphBuilder and its lookups are garbage now.
      collectGarbageAfterGrowth();
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
