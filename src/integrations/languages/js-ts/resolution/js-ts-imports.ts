import {
  createJsTsConfiguredImportBasePaths,
  type JsTsResolutionConfig,
} from "./config.js";
import { createRelativeImportCandidates } from "../../../../core/scan/resolution/import-candidates.js";

export function resolveJsTsConfiguredImport(
  source: string,
  fileIdByRelativePath: Map<string, string>,
  config: JsTsResolutionConfig,
): string | null {
  for (const candidateBasePath of createJsTsConfiguredImportBasePaths(source, config)) {
    for (const candidate of createRelativeImportCandidates(candidateBasePath)) {
      const targetFileId = fileIdByRelativePath.get(candidate);
      if (targetFileId) {
        return targetFileId;
      }
    }
  }

  return null;
}
