import path from "node:path";
import { openGraphStore } from "../../composition/graph-store.js";
import { createFreshness, parseListedTools, runMcpServer, type McpServerHooks } from "../mcp/index.js";
import { startWatch } from "./watch.js";

export type McpAdapterOptions = {
  database: string;
  // Project to keep the graph current for: scanned at start, rescanned on change.
  watch?: string;
  manifest?: string;
  continueOnError?: boolean;
  include?: string[];
  exclude?: string[];
  apiOrigin?: string[];
  cacheDir?: string;
  // Comma-separated tool names to list (default: CONCENTRATE_MCP_TOOLS, else all).
  tools?: string;
};

// The longest a tool call waits for a running or pending rescan; after that
// it answers from the snapshot, and the stale field covers what changed.
export const WATCH_WAIT_MS = 30_000;

export async function runMcpAdapter(options: McpAdapterOptions): Promise<void> {
  const databasePath = path.resolve(options.database);
  const manifestPath = path.resolve(options.manifest ?? path.join(path.dirname(databasePath), "scan-manifest.json"));
  const hooks: McpServerHooks = { freshness: createFreshness(manifestPath) };
  const toolList = options.tools ?? process.env.CONCENTRATE_MCP_TOOLS;
  if (toolList !== undefined && toolList.trim() !== "") hooks.listedTools = parseListedTools(toolList);

  const watcher = options.watch === undefined ? null : startWatch(options.watch, {
    database: databasePath,
    continueOnError: options.continueOnError ?? false,
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    apiOrigin: options.apiOrigin,
    retryLock: true,
    cacheDir: options.cacheDir ?? path.join(path.dirname(databasePath), "cache"),
    manifest: manifestPath,
  }, (scan) => {
    // stdout carries the protocol; progress goes to stderr.
    if (scan.error) process.stderr.write(`concentrate: rescan failed: ${scan.error instanceof Error ? scan.error.message : String(scan.error)}\n`);
  });
  if (watcher) {
    // Reconcile with the working tree: wait for the start-up scan and for any
    // change still waiting out its debounce before answering.
    hooks.beforeCall = async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, WATCH_WAIT_MS); });
      try {
        await Promise.race([watcher.idle(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };
  }

  try {
    await runMcpServer(async () => openGraphStore(databasePath), hooks);
  } finally {
    await watcher?.close();
  }
}
