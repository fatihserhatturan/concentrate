import type { IncrementalEligibility } from "./scan-manifest.js";
import type { SupportedSourceFile } from "./source-files.js";

export type IncrementalMode = "full" | "changed-files";

export type ParsePlan = {
  requestedMode: IncrementalMode;
  effectiveMode: "full";
  reason: string | null;
  filesToParse: number;
  filesPlannedForReuse: number;
  addedFiles: string[];
  changedFiles: string[];
  unchangedFiles: string[];
  deletedFiles: string[];
};

export function createParsePlan(
  supportedFiles: SupportedSourceFile[],
  incremental: IncrementalEligibility,
  requestedMode: IncrementalMode,
): ParsePlan {
  if (requestedMode === "full") {
    return fullParsePlan(supportedFiles, requestedMode, null);
  }

  if (!incremental.checked) {
    return fullParsePlan(supportedFiles, requestedMode, "No previous manifest provided");
  }

  if (!incremental.compatible) {
    return fullParsePlan(supportedFiles, requestedMode, incremental.reason ?? "Previous manifest is not compatible");
  }

  const details = incrementalDetails(incremental);
  return {
    requestedMode,
    effectiveMode: "full",
    reason: "Changed-file-only parsing is not implemented yet; running a full parse before patching graph",
    filesToParse: supportedFiles.length,
    filesPlannedForReuse: details.unchangedFiles.length,
    addedFiles: details.addedFiles,
    changedFiles: details.changedFiles,
    unchangedFiles: details.unchangedFiles,
    deletedFiles: details.deletedFiles,
  };
}

function fullParsePlan(
  supportedFiles: SupportedSourceFile[],
  requestedMode: IncrementalMode,
  reason: string | null,
): ParsePlan {
  return {
    requestedMode,
    effectiveMode: "full",
    reason,
    filesToParse: supportedFiles.length,
    filesPlannedForReuse: 0,
    addedFiles: [],
    changedFiles: [],
    unchangedFiles: [],
    deletedFiles: [],
  };
}

function incrementalDetails(incremental: IncrementalEligibility): {
  addedFiles: string[];
  changedFiles: string[];
  unchangedFiles: string[];
  deletedFiles: string[];
} {
  const details = incremental as IncrementalEligibility & {
    addedFiles?: string[];
    changedFiles?: string[];
    unchangedFiles?: string[];
    deletedFiles?: string[];
  };

  return {
    addedFiles: details.addedFiles ?? [],
    changedFiles: details.changedFiles ?? [],
    unchangedFiles: details.unchangedFiles ?? [],
    deletedFiles: details.deletedFiles ?? [],
  };
}
