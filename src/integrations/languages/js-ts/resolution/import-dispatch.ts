import path from "node:path";
import type { GoResolutionConfig } from "../../../../integrations/languages/go/resolution.js";
import type { JsTsResolutionConfig } from "./config.js";
import {
  isGoFile,
  isJsTsFile,
  isRustFile,
  shouldResolveAbsoluteImport,
} from "../../../../core/scan/resolution/file-kind.js";
import { resolveGoImport } from "../../../../integrations/languages/go/resolution.js";
import {
  createPythonModuleCandidates,
  createRelativeImportCandidates,
} from "../../../../core/scan/resolution/import-candidates.js";
import { resolveJsTsConfiguredImport } from "./js-ts-imports.js";
import { resolveRustImport } from "../../../../integrations/languages/rust/resolution.js";

export function resolveImport(
  source: string,
  importerFileId: string,
  fileIdByRelativePath: Map<string, string>,
  jsTsConfig: JsTsResolutionConfig,
  goConfig: GoResolutionConfig,
): string | null {
  if (!source.startsWith(".")) {
    return resolveAbsoluteImport(source, importerFileId, fileIdByRelativePath, jsTsConfig, goConfig);
  }

  const importerRelativePath = importerFileId.slice("file:".length);
  const importerDirectory = path.posix.dirname(toPosixPath(importerRelativePath));
  const importBasePath = path.posix.normalize(path.posix.join(importerDirectory, source));

  for (const candidate of createRelativeImportCandidates(importBasePath)) {
    const targetFileId = fileIdByRelativePath.get(candidate);
    if (targetFileId) return targetFileId;
  }

  return null;
}

function resolveAbsoluteImport(
  source: string,
  importerFileId: string,
  fileIdByRelativePath: Map<string, string>,
  jsTsConfig: JsTsResolutionConfig,
  goConfig: GoResolutionConfig,
): string | null {
  if (isJsTsFile(importerFileId)) {
    return resolveJsTsConfiguredImport(source, fileIdByRelativePath, jsTsConfig);
  }

  if (isGoFile(importerFileId)) {
    return resolveGoImport(source, fileIdByRelativePath, goConfig);
  }

  if (isRustFile(importerFileId)) {
    return resolveRustImport(source, importerFileId, fileIdByRelativePath);
  }

  if (!shouldResolveAbsoluteImport(importerFileId)) {
    return null;
  }

  const importBasePath = source.replaceAll(".", "/");
  for (const candidate of createPythonModuleCandidates(importBasePath)) {
    const targetFileId = fileIdByRelativePath.get(candidate);
    if (targetFileId) return targetFileId;
  }

  return null;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
