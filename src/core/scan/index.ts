export type {
  FileClassificationCounts,
  FileSourceType,
} from "./file-classification.js";
export type {
  IncrementalEligibility,
  ManifestDiff,
  ScanManifest,
  ScanManifestFile,
} from "./manifest.js";
export type {
  IncrementalMode,
  ParsePlan,
} from "./parse-plan.js";
export type {
  GraphPatchReport,
  ScanFailure,
  ScanReport,
  ScanStatus,
  ScanWarning,
} from "./report.js";
export { buildCodeGraph, scanOrchestrator } from "../../composition/orchestrator.js";
export { buildCodeGraph as coreBuildCodeGraph, createScanOrchestrator, type ScanDependencies } from "./orchestrator.js";
export {
  addScanWarning,
  addUniqueScanWarning,
  createScanFailure,
  createScanReport,
  didFailFast,
  didPartiallySucceed,
} from "./report.js";
export type {
  BuildCodeGraphOptions,
  BuildCodeGraphResult,
} from "./result.js";
