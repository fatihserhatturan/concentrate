import type { GraphNode, GraphRelationship } from "../graph/model.js";
import type { IncrementalMode } from "./parse-plan.js";
import type { ScanReport } from "./report.js";
// ScanManifest remains in scanner/scan-manifest (FS-bound) as a documented shim.
import type { ScanManifest } from "../../scanner/scan-manifest.js";

export type BuildCodeGraphOptions = {
  continueOnError: boolean;
  concurrency?: number;
  maxFiles?: number;
  include?: string[];
  exclude?: string[];
  previousManifestPath?: string;
  incrementalMode?: IncrementalMode;
  onProgress?: (current: number, total: number, relativePath: string) => void;
};

export type BuildCodeGraphResult = {
  rootPath: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  report: ScanReport;
  manifest: ScanManifest;
};
