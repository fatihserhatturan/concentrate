import type { GraphNode, GraphRelationship } from "../graph/model.js";
import type { ScanReport } from "./report.js";

export type BuildCodeGraphOptions = {
  continueOnError: boolean;
  concurrency?: number;
  maxFiles?: number;
  include?: string[];
  exclude?: string[];
  onProgress?: (current: number, total: number, relativePath: string) => void;
};

export type BuildCodeGraphResult = {
  rootPath: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  report: ScanReport;
};
