import type { GraphNode, GraphRelationship } from "../graph/model.js";
import type { ScanReport } from "./report.js";
import type { ScanManifest } from "./manifest.js";

export type BuildCodeGraphOptions = {
  continueOnError: boolean;
  concurrency?: number;
  // Worker threads for parsing: unset picks a count from the number of files
  // to parse (see parseWorkerCount), 0 parses on the main thread.
  workers?: number;
  maxFiles?: number;
  include?: string[];
  exclude?: string[];
  // Origins that serve this project's routes (see ScanSettings.apiOrigins).
  apiOrigins?: string[];
  // Reuse per-file parse results stored here (see parse-cache.ts); unset parses every file.
  cacheDirectory?: string;
  onProgress?: (current: number, total: number, relativePath: string) => void;
};

export type BuildCodeGraphResult = {
  rootPath: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  report: ScanReport;
  manifest: ScanManifest;
};
