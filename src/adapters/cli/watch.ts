import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { BuildCodeGraphResult } from "../../core/scan/index.js";
import { didFailFast } from "../../core/scan/index.js";
import { scanIntoStore, type ScanAdapterOptions } from "../../composition/scan-into-store.js";

export type WatchAdapterOptions = ScanAdapterOptions & {
  // Quiet period after the last file event before rescanning, in milliseconds.
  debounce?: number;
};

export type WatchScan = {
  result: BuildCodeGraphResult | null;
  error: unknown;
  durationMs: number;
};

export type WatchHandle = {
  // Resolves when no scan is running or scheduled.
  idle(): Promise<void>;
  close(): Promise<void>;
};

// Directories whose changes never affect the graph.
const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".concentrate"]);

// Scans once, then rescans whenever a file under `projectPath` changes. Each
// rescan uses the parse cache, so only changed files are parsed, and rewrites
// the store, which running MCP servers pick up on their next call. A scan that
// fails fast leaves the store as it was; the next change tries again.
export function startWatch(
  projectPath: string,
  options: WatchAdapterOptions,
  onScan: (scan: WatchScan) => void,
): WatchHandle {
  const rootPath = path.resolve(projectPath);
  const ownOutputs = [options.database, options.cacheDir, options.manifest].map((output) => path.resolve(output));
  const debounce = options.debounce ?? 200;

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  let pending = false;
  let closed = false;
  let idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    if (running || pending || timer) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters = [];
  };

  const runScan = async () => {
    const startedAt = performance.now();
    let scan: WatchScan;
    try {
      scan = { result: await scanIntoStore(rootPath, options), error: null, durationMs: 0 };
    } catch (error) {
      scan = { result: null, error, durationMs: 0 };
    }
    scan.durationMs = performance.now() - startedAt;
    onScan(scan);
  };

  const scanNow = () => {
    timer = undefined;
    if (closed) return settleIdle();
    if (running) {
      pending = true;
      return;
    }
    running = runScan().finally(() => {
      running = null;
      if (pending && !closed) {
        pending = false;
        scanNow();
      } else {
        pending = false;
        settleIdle();
      }
    });
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(scanNow, debounce);
  };

  const watcher: FSWatcher = watch(rootPath, { recursive: true }, (_event, fileName) => {
    if (fileName && isIgnored(rootPath, ownOutputs, fileName.toString())) return;
    schedule();
  });

  scanNow();

  return {
    idle: () => new Promise((resolve) => {
      idleWaiters.push(resolve);
      settleIdle();
    }),
    close: async () => {
      closed = true;
      watcher.close();
      clearTimeout(timer);
      timer = undefined;
      pending = false;
      await running;
      settleIdle();
    },
  };
}

function isIgnored(rootPath: string, ownOutputs: string[], fileName: string): boolean {
  if (fileName.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  const absolute = path.resolve(rootPath, fileName);
  return ownOutputs.some((output) => absolute === output || absolute.startsWith(`${output}${path.sep}`));
}

export async function runWatchAdapter(projectPath: string, options: WatchAdapterOptions): Promise<void> {
  const rootPath = path.resolve(projectPath);
  console.log(`Watching ${rootPath} (Ctrl+C to stop)`);

  const handle = startWatch(rootPath, options, (scan) => console.log(formatWatchScan(scan)));
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void handle.close().then(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

export function formatWatchScan(scan: WatchScan): string {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const duration = `${Math.round(scan.durationMs)} ms`;
  if (!scan.result) {
    const message = scan.error instanceof Error ? scan.error.message : String(scan.error);
    return `[${time}] scan error: ${message} (${duration})`;
  }

  const { report, nodes, relationships } = scan.result;
  const parsed = report.parseCache.enabled ? report.parseCache.misses : report.parsedFiles;
  const summary = `${report.supportedFiles} files, ${parsed} parsed, ${nodes.length} nodes, ${relationships.length} rels`;
  if (didFailFast(scan.result)) {
    const failure = report.failedFiles[0];
    return `[${time}] not written, ${failure?.path}: ${failure?.message} (${duration}; graph unchanged)`;
  }
  const failed = report.failedFiles.length > 0 ? `, ${report.failedFiles.length} failed` : "";
  return `[${time}] ${summary}${failed} (${duration})`;
}
