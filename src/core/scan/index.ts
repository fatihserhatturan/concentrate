export type {
  FileClassificationCounts,
  FileSourceType,
} from "./file-classification.js";
export type {
  ScanManifest,
  ScanManifestFile,
} from "./manifest.js";
export type { ParseCacheReport } from "./report.js";
export type {
  ScanFailure,
  ScanReport,
  ScanStatus,
  ScanWarning,
} from "./report.js";
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
