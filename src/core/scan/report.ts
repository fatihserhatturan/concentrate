import path from "node:path";
import type { BuildCodeGraphResult } from "./result.js";
import { createFileClassificationCounts, type FileClassificationCounts } from "./file-classification.js";
import { createParseCacheReport, type ParseCacheReport } from "./parse-cache.js";

export type ScanStatus = "success" | "partial" | "failed";

export type ScanReport = {
  discoveredFiles: number;
  // Code files (parsed for declarations) and the other files of the project
  // (`File` nodes only); skipped files are left out by --max-files.
  supportedFiles: number;
  otherFiles: number;
  skippedFiles: number;
  parsedFiles: number;
  status: ScanStatus;
  fileClassifications: FileClassificationCounts;
  resolvedImports: number;
  unresolvedRelativeImports: number;
  parseCache: ParseCacheReport;
  // Worker threads that parsed the files the cache did not have; 0 = main thread.
  parseWorkers: number;
  failedFiles: ScanFailure[];
  warnings: ScanWarning[];
};

export type ScanFailure = {
  path: string;
  message: string;
};

export type ScanWarning = {
  path: string;
  message: string;
};

export function createScanReport(discoveredFiles: number, supportedFiles: number, otherFiles = 0): ScanReport {
  return {
    discoveredFiles,
    supportedFiles,
    otherFiles,
    skippedFiles: discoveredFiles - supportedFiles - otherFiles,
    parsedFiles: 0,
    status: "success",
    fileClassifications: createFileClassificationCounts(),
    resolvedImports: 0,
    unresolvedRelativeImports: 0,
    parseCache: createParseCacheReport(),
    parseWorkers: 0,
    failedFiles: [],
    warnings: [],
  };
}

export function createScanFailure(rootPath: string, filePath: string, error: unknown): ScanFailure {
  return {
    path: path.relative(rootPath, filePath),
    message: error instanceof Error ? error.message : String(error),
  };
}

export function addScanWarning(report: ScanReport, rootPath: string, filePath: string, error: unknown): void {
  const warning = {
    path: path.relative(rootPath, filePath),
    message: error instanceof Error ? error.message : String(error),
  };
  addUniqueScanWarning(report, warning);
}

export function addUniqueScanWarning(report: ScanReport, warning: ScanWarning): void {
  if (report.warnings.some((existing) => existing.path === warning.path && existing.message === warning.message)) {
    return;
  }
  report.warnings.push(warning);
}

export function didFailFast(result: BuildCodeGraphResult): boolean {
  return result.report.status === "failed";
}

export function didPartiallySucceed(result: BuildCodeGraphResult): boolean {
  return result.report.status === "partial";
}
