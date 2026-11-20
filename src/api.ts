// Programmatic entry point (dist/api.js). The optional UI in ui/ imports the
// built core through this file only, so it never reaches into internal paths.
export { scanIntoStore, type ScanAdapterOptions } from "./composition/scan-into-store.js";
export { formatJsonl } from "./core/graph/jsonl.js";
export { writeJsonl } from "./composition/jsonl.js";
export { scanOrchestrator, buildCodeGraph } from "./composition/orchestrator.js";
export { openGraphStore, GRAPH_SCHEMA_VERSION, type OpenGraphStoreOptions } from "./composition/graph-store.js";
export type {
  GraphNode,
  GraphNodeLabel,
  GraphProperties,
  GraphRelationship,
  GraphRelationshipType,
} from "./core/graph/model.js";
export type { GraphRecordVisitor, IGraphStore } from "./core/contracts/graph-store.js";
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
import { defaultLanguageTable } from "./composition/default-registry.js";
import { graphSummary as coreGraphSummary } from "./core/queries/summary.js";
import type { IQueryEngine as SummaryEngine } from "./core/contracts/query-engine.js";
export const graphSummary = (engine: SummaryEngine) => coreGraphSummary(engine, { codeLanguages: defaultLanguageTable.codeLanguages });
export { defaultLanguageTable };
export { nodeLabels, nodeTables, relationshipTables, type NodeTable, type RelationshipTable } from "./adapters/store/schema.js";
export { matchName, type MatchType } from "./core/queries/match.js";
export type { ISourceReader } from "./core/contracts/source-reader.js";
export { findUnusedExports, type FindUnusedExportsOptions, type UnusedExport, type UnusedExportsResult } from "./core/queries/unused.js";
export { defaultUnusedExportRules } from "./composition/unused-rules.js";
export type { IUnusedExportRules } from "./core/contracts/unused-rules.js";
export { findImportCycles, type ImportCycle, type ImportCyclesResult } from "./core/queries/cycles.js";
