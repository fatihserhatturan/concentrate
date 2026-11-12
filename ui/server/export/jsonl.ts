import path from "node:path";
import { formatJsonl, scanOrchestrator } from "../core.js";
import { lastScanRequests, scanOptionsFor } from "../api/scan.js";
import { zip } from "./zip.js";
import type { Selection } from "./select.js";

type Records = Parameters<typeof formatJsonl>[0];

function files(nodes: string, relationships: string, summary: unknown): Buffer {
  return zip([
    { name: "nodes.jsonl", data: Buffer.from(nodes) },
    { name: "relationships.jsonl", data: Buffer.from(relationships) },
    { name: "summary.json", data: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`) },
  ]);
}

/** A selection (a view) as JSONL; records come from the store. */
export function jsonlZip(selection: Selection): Buffer {
  return files(formatJsonl(selection.nodes as unknown as Records), formatJsonl(selection.edges as unknown as Records), {
    rootPath: selection.index.rootPath,
    schemaVersion: selection.index.schemaVersion,
    nodes: selection.nodes.length,
    relationships: selection.edges.length,
  });
}

/**
 * The whole graph as `concentrate export` writes it. The store keeps unset and null
 * properties apart no longer, so the records are rebuilt with the same scan (the parse
 * cache makes that fast) and the options of the last scan, and written by the same code.
 */
export async function jsonlZipFromScan(projectPath: string): Promise<Buffer> {
  const root = path.resolve(projectPath);
  const options = scanOptionsFor(root, lastScanRequests.get(root) ?? { path: root });
  const result = await scanOrchestrator.buildGraph(root, {
    continueOnError: options.continueOnError,
    include: options.include.length > 0 ? options.include : undefined,
    exclude: options.exclude.length > 0 ? options.exclude : undefined,
    apiOrigins: options.apiOrigin,
    cacheDirectory: options.cache === false ? undefined : options.cacheDir,
  });
  return files(formatJsonl(result.nodes), formatJsonl(result.relationships), {
    rootPath: result.rootPath,
    report: result.report,
    manifest: { path: "manifest.json", files: result.manifest.files.length, hashAlgorithm: result.manifest.hashAlgorithm },
    nodes: result.nodes.length,
    relationships: result.relationships.length,
  });
}
