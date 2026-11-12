import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { McpToolResult } from "./tools.js";

// Staleness of tool answers. The scan manifest records the size-and-mtime of
// every file the graph was built from. A tool result that names a file whose
// mtime differs now (or that is gone) may describe code that no longer exists,
// so the result gets a `stale` field telling the agent to read those files.
// Only files named in the result are checked, so the cost per call is a few
// stat calls. Files created after the scan are not known to the manifest;
// `concentrate mcp --watch` covers those.

export const STALE_NOTE = "These files changed after the graph was built; the answer may be out of date for them. Read them directly.";

const MAX_LISTED = 20;

type Manifest = { rootPath: string; files: Map<string, number> };

export type Freshness = {
  // Returns the result with `stale` added when it names changed files.
  annotate(result: McpToolResult): Promise<McpToolResult>;
};

export function createFreshness(manifestPath: string): Freshness {
  let cached: { mtimeMs: number; manifest: Manifest } | null = null;

  const load = async (): Promise<Manifest | null> => {
    try {
      const { mtimeMs } = await stat(manifestPath);
      if (cached?.mtimeMs === mtimeMs) return cached.manifest;
      const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { rootPath?: unknown; files?: unknown };
      if (typeof raw.rootPath !== "string" || !Array.isArray(raw.files)) return null;
      const files = new Map<string, number>();
      for (const file of raw.files as Array<{ path?: unknown; mtimeMs?: unknown }>) {
        if (typeof file.path === "string" && typeof file.mtimeMs === "number") files.set(file.path, file.mtimeMs);
      }
      cached = { mtimeMs, manifest: { rootPath: raw.rootPath, files } };
      return cached.manifest;
    } catch {
      return null;
    }
  };

  return {
    async annotate(result) {
      if (result.isError || !result.structuredContent) return result;
      const manifest = await load();
      if (!manifest) return result;

      const named = new Set<string>();
      collectPaths(result.structuredContent, manifest.files, named);
      const changed: string[] = [];
      for (const file of named) {
        const recorded = manifest.files.get(file)!;
        if (await currentMtime(path.join(manifest.rootPath, file)) !== recorded) changed.push(file);
      }
      if (changed.length === 0) return result;

      changed.sort();
      const stale = { files: changed.slice(0, MAX_LISTED), ...(changed.length > MAX_LISTED ? { more: changed.length - MAX_LISTED } : {}), note: STALE_NOTE };
      const structuredContent = { ...result.structuredContent, stale };
      return { ...result, content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
    },
  };
}

async function currentMtime(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

function collectPaths(value: unknown, known: Map<string, number>, found: Set<string>): void {
  if (typeof value === "string") {
    if (known.has(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, known, found);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectPaths(child, known, found);
  }
}
