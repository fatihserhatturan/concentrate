import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { openGraphStore } from "../core.js";
import { graphPath } from "../graph/index.js";

export type ProjectInfo = {
  path: string;
  name: string;
  exists: boolean;
  isGitRepository: boolean;
  hasGraph: boolean;
  /** When the graph was last written (ISO time), null without a graph. */
  scannedAt: string | null;
  files: number | null;
  nodes: number | null;
  schemaVersion: number | null;
};

const cache = new Map<string, { signature: string; nodes: number; schemaVersion: number | null }>();

async function mtime(target: string): Promise<number | null> {
  return (await stat(target).catch(() => null))?.mtimeMs ?? null;
}

/** What a project card shows: cheap facts from the store folder, the manifest and the store's own counts. */
export async function projectInfo(requested: string): Promise<ProjectInfo> {
  const root = path.resolve(requested);
  const base: ProjectInfo = {
    path: root,
    name: path.basename(root) || root,
    exists: false,
    isGitRepository: false,
    hasGraph: false,
    scannedAt: null,
    files: null,
    nodes: null,
    schemaVersion: null,
  };
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) return base;
  base.exists = true;
  base.isGitRepository = (await mtime(path.join(root, ".git"))) !== null;
  const graphDir = graphPath(root);
  const written = (await mtime(path.join(graphDir, "HEAD"))) ?? (await mtime(graphDir));
  if (written === null) return base;
  base.hasGraph = true;
  base.scannedAt = new Date(written).toISOString();

  const manifest = await readFile(path.join(root, ".concentrate", "scan-manifest.json"), "utf8").then(JSON.parse, () => null);
  if (manifest && Array.isArray(manifest.files)) base.files = manifest.files.length;

  const signature = String(written);
  let counts = cache.get(root);
  if (!counts || counts.signature !== signature) {
    const store = await openGraphStore(graphDir, { retryLock: false }).catch(() => null);
    if (store) {
      try {
        const stats = await store.stats();
        counts = { signature, nodes: stats.reduce((sum, row) => sum + Number(row.count), 0), schemaVersion: await store.schemaVersion() };
        cache.set(root, counts);
      } finally {
        await store.close();
      }
    }
  }
  if (counts) {
    base.nodes = counts.nodes;
    base.schemaVersion = counts.schemaVersion;
  }
  return base;
}
