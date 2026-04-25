import path from "node:path";
import type { BuildCodeGraphResult } from "./build-code-graph.js";

export type ScanReport = {
  discoveredFiles: number;
  supportedFiles: number;
  skippedFiles: number;
  parsedFiles: number;
  resolvedImports: number;
  unresolvedRelativeImports: number;
  failedFiles: ScanFailure[];
};

export type ScanFailure = {
  path: string;
  message: string;
};

export function createScanReport(discoveredFiles: number, supportedFiles: number): ScanReport {
  return {
    discoveredFiles,
    supportedFiles,
    skippedFiles: discoveredFiles - supportedFiles,
    parsedFiles: 0,
    resolvedImports: 0,
    unresolvedRelativeImports: 0,
    failedFiles: [],
  };
}

export function createScanFailure(rootPath: string, filePath: string, error: unknown): ScanFailure {
  return {
    path: path.relative(rootPath, filePath),
    message: error instanceof Error ? error.message : String(error),
  };
}

export function didFailFast(result: BuildCodeGraphResult): boolean {
  return result.report.failedFiles.length > 0
    && result.report.parsedFiles < result.report.supportedFiles;
}
