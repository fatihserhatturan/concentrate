import path from "node:path";
import type { BuildCodeGraphResult } from "./build-code-graph.js";
import { createFileClassificationCounts, type FileClassificationCounts } from "./file-classification.js";

export type ScanStatus = "success" | "partial" | "failed";

export type ScanReport = {
  discoveredFiles: number;
  supportedFiles: number;
  skippedFiles: number;
  parsedFiles: number;
  status: ScanStatus;
  fileClassifications: FileClassificationCounts;
  resolvedImports: number;
  unresolvedRelativeImports: number;
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

export function createScanReport(discoveredFiles: number, supportedFiles: number): ScanReport {
  return {
    discoveredFiles,
    supportedFiles,
    skippedFiles: discoveredFiles - supportedFiles,
    parsedFiles: 0,
    status: "success",
    fileClassifications: createFileClassificationCounts(),
    resolvedImports: 0,
    unresolvedRelativeImports: 0,
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
