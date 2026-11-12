import { stat } from "node:fs/promises";
import path from "node:path";
import { invalidateIndex } from "../graph/index.js";
import { didFailFast, didPartiallySucceed, scanIntoStore, type ScanAdapterOptions } from "../core.js";

export type ScanRequest = {
  path: string;
  include?: string[];
  exclude?: string[];
  apiOrigins?: string[];
  cache?: boolean;
};

export type ScanEvent =
  | { type: "progress"; current: number; total: number; file: string }
  | { type: "done"; status: "ok" | "partial" | "failed"; nodes: number; relationships: number; report: unknown; database: string }
  | { type: "error"; message: string };

/** The options of the last scan of each project, so a JSONL export can rebuild the same graph. */
export const lastScanRequests = new Map<string, ScanRequest>();

export function parseScanRequest(body: unknown): ScanRequest {
  if (typeof body !== "object" || body === null) throw new Error("Body must be a JSON object");
  const input = body as Record<string, unknown>;
  if (typeof input.path !== "string" || input.path.length === 0) throw new Error("`path` is required");
  const strings = (value: unknown, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`\`${name}\` must be a list of strings`);
    return value as string[];
  };
  return {
    path: input.path,
    include: strings(input.include, "include"),
    exclude: strings(input.exclude, "exclude"),
    apiOrigins: strings(input.apiOrigins, "apiOrigins"),
    cache: typeof input.cache === "boolean" ? input.cache : undefined,
  };
}

/** The CLI defaults, rooted in the project, so `concentrate mcp` reads what the UI wrote. */
export function scanOptionsFor(projectPath: string, request: ScanRequest): ScanAdapterOptions {
  const store = path.join(projectPath, ".concentrate");
  return {
    database: path.join(store, "graph"),
    cacheDir: path.join(store, "cache"),
    manifest: path.join(store, "scan-manifest.json"),
    continueOnError: true,
    include: request.include ?? [],
    exclude: request.exclude ?? [],
    apiOrigin: request.apiOrigins,
    cache: request.cache,
    retryLock: true,
  };
}

export async function runScan(request: ScanRequest, emit: (event: ScanEvent) => void): Promise<void> {
  const projectPath = path.resolve(request.path);
  const info = await stat(projectPath).catch(() => undefined);
  if (!info?.isDirectory()) {
    emit({ type: "error", message: `Not a directory: ${projectPath}` });
    return;
  }
  const options = scanOptionsFor(projectPath, request);
  lastScanRequests.set(projectPath, request);
  let lastEmit = 0;
  try {
    const result = await scanIntoStore(projectPath, options, (current, total, file) => {
      const now = Date.now();
      if (current !== total && now - lastEmit < 100) return;
      lastEmit = now;
      emit({ type: "progress", current, total, file });
    });
    invalidateIndex(projectPath);
    emit({
      type: "done",
      status: didFailFast(result) ? "failed" : didPartiallySucceed(result) ? "partial" : "ok",
      nodes: result.nodes.length,
      relationships: result.relationships.length,
      report: result.report,
      database: options.database,
    });
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
