// Programmatic entry point (dist/api.js). The optional UI in ui/ imports the
// built core through this file only, so it never reaches into internal paths.
export { scanIntoStore, type ScanAdapterOptions } from "./adapters/cli/scan.js";
export { formatJsonl, writeJsonl } from "./adapters/cli/jsonl.js";
export { scanOrchestrator, buildCodeGraph } from "./composition/orchestrator.js";
export { openGraphStore, GRAPH_SCHEMA_VERSION, type OpenGraphStoreOptions } from "./composition/graph-store.js";
export type {
  GraphNode,
  GraphNodeLabel,
  GraphProperties,
  GraphRelationship,
  GraphRelationshipType,
} from "./core/graph/model.js";
export type { IGraphStore } from "./core/contracts/graph-store.js";
export type { GraphStatsOptions, GraphStatsRow, IQueryEngine, QueryParameters } from "./core/contracts/query-engine.js";
export {
  didFailFast,
  didPartiallySucceed,
  type BuildCodeGraphOptions,
  type BuildCodeGraphResult,
  type ScanFailure,
  type ScanManifest,
  type ScanReport,
  type ScanStatus,
  type ScanWarning,
} from "./core/scan/index.js";
export { graphSummary } from "./adapters/mcp/resources.js";
export { nodeLabels, relationshipTables, type RelationshipTable } from "./adapters/store/schema.js";
export { matchName, type MatchType } from "./adapters/mcp/analysis-tools/search.js";
