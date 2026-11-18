import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { GRAPH_SCHEMA_VERSION } from "../core.js";
import { graphPath, readGraphHead } from "../graph/index.js";

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
  /** The schema this build writes; a graph of an older one should be scanned again. */
  currentSchemaVersion: number;
};

async function mtime(target: string): Promise<number | null> {
  return (await stat(target).catch(() => null))?.mtimeMs ?? null;
}

/** What a project card shows: cheap facts from the store's HEAD.json and the scan manifest; the store itself is never opened. */
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
    currentSchemaVersion: GRAPH_SCHEMA_VERSION,
  };
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) return base;
  base.exists = true;
  base.isGitRepository = (await mtime(path.join(root, ".git"))) !== null;
  const head = await readGraphHead(graphPath(root));
  if (!head) return base;
  base.hasGraph = true;
  // The scan time is when the store committed; the file's mtime stands in for an older manifest without it.
  const written = head.writtenAt ? Date.parse(head.writtenAt) : Number.NaN;
  base.scannedAt = new Date(Number.isFinite(written) ? written : head.mtimeMs).toISOString();
  base.nodes = head.nodes;
  base.schemaVersion = head.schemaVersion;

  const manifest = await readFile(path.join(root, ".concentrate", "scan-manifest.json"), "utf8").then(JSON.parse, () => null);
  if (manifest && Array.isArray(manifest.files)) base.files = manifest.files.length;
  return base;
}
