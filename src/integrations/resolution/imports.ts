import type { IGraphContributor } from "../../core/contracts/graph-contributor.js";
import {
  createJsTsConfiguredImportBasePaths,
  readJsTsResolutionConfigWithWarnings,
  type JsTsResolutionConfig,
} from "../languages/js-ts/resolution/config.js";
import {
  goPackageDirectory,
  indexGoFilesByDirectory,
  readGoResolutionConfig,
  resolveGoImport,
  type GoResolutionConfig,
} from "../languages/go/resolution.js";
import {
  isGoFile,
  isJsTsFile,
  isRustFile,
  shouldResolveAbsoluteImport,
} from "../../core/scan/resolution/file-kind.js";
import { isStyleFile, resolveStyleImport } from "../languages/plain/style-resolution.js";
import { resolveImport } from "../languages/js-ts/resolution/import-dispatch.js";
import { createFileIndex, createImporterIndex } from "../languages/js-ts/resolution/import-indexes.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { addUniqueScanWarning, type ScanReport } from "../../core/scan/report.js";

export async function addImportResolutionRelationships(
  graph: IGraphContributor,
  rootPath: string,
  report?: ScanReport,
): Promise<{
  resolved: number;
  unresolved: number;
}> {
  const fileIdByRelativePath = createFileIndex(graph.nodes);
  const importerFileIdByImportId = createImporterIndex(graph.relationships);
  const jsTsConfig = await readJsTsResolutionConfigWithWarnings(rootPath, (filePath, error) => {
    if (!report) return;
    addUniqueScanWarning(report, {
      path: path.relative(rootPath, filePath),
      message: error instanceof Error ? error.message : String(error),
    });
  });
  const goConfig = await readGoResolutionConfig(rootPath, fileIdByRelativePath.keys());
  const goFilesByDirectory = indexGoFilesByDirectory(fileIdByRelativePath);
  // A bare specifier tried only because of `baseUrl` (`next/link` against
  // `baseUrl: "."`) is a package import, not an unresolved one, unless its
  // first segment names a file or folder under baseUrl (`types` for
  // `types/index.d.ts`). Path aliases, package `imports` and workspace
  // packages are always counted.
  const baseUrlEntries = new Map<string, boolean>();
  const isPackageImport = (source: string, importerFileId: string): boolean => {
    const baseUrl = jsTsConfig.baseUrl;
    if (source.startsWith(".") || !isJsTsFile(importerFileId) || !baseUrl) return false;
    if (createJsTsConfiguredImportBasePaths(source, { ...jsTsConfig, baseUrl: null }).length > 0) return false;
    const segment = source.split("/")[0]!;
    let local = baseUrlEntries.get(segment);
    if (local === undefined) {
      const entry = path.join(rootPath, baseUrl, segment);
      local = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"].some((extension) => existsSync(`${entry}${extension}`));
      baseUrlEntries.set(segment, local);
    }
    return !local;
  };
  let resolved = 0;
  let unresolved = 0;

  for (const node of graph.nodes) {
    if (node.label !== "Import") {
      continue;
    }

    const source = node.properties.source;
    if (typeof source !== "string") {
      continue;
    }

    const importerFileId = importerFileIdByImportId.get(node.id);

    // A style sheet's imports and `url()`s are paths of the project; a bare
    // Sass name may be a package, which is not counted as unresolved.
    if (importerFileId && isStyleFile(importerFileId)) {
      const targetFileId = resolveStyleImport(source, importerFileId, fileIdByRelativePath);
      if (targetFileId) {
        graph.addRelationship({ from: node.id, to: targetFileId, type: "RESOLVES_TO", properties: {} });
        resolved += 1;
      } else if (source.startsWith(".")) {
        unresolved += 1;
      }
      continue;
    }

    if (!importerFileId || !shouldAttemptResolution(source, importerFileId, jsTsConfig, goConfig)) {
      continue;
    }

    // A Go import is a package: every file of its directory.
    if (isGoFile(importerFileId)) {
      const targetFileIds = resolveGoImport(source, goFilesByDirectory, goConfig);
      if (targetFileIds.length === 0) unresolved += 1;
      for (const targetFileId of targetFileIds) {
        graph.addRelationship({ from: node.id, to: targetFileId, type: "RESOLVES_TO", properties: {} });
      }
      if (targetFileIds.length > 0) resolved += 1;
      continue;
    }

    const targetFileId = resolveImport(source, importerFileId, fileIdByRelativePath, jsTsConfig);

    if (!targetFileId) {
      if (!isPackageImport(source, importerFileId)) unresolved += 1;
      continue;
    }

    graph.addRelationship({
      from: node.id,
      to: targetFileId,
      type: "RESOLVES_TO",
      properties: {},
    });
    resolved += 1;
  }

  return { resolved, unresolved };
}


function shouldAttemptResolution(
  source: string,
  importerFileId: string,
  jsTsConfig: JsTsResolutionConfig,
  goConfig: GoResolutionConfig,
): boolean {
  if (source.startsWith(".")) {
    return true;
  }

  if (isJsTsFile(importerFileId)) {
    return createJsTsConfiguredImportBasePaths(source, jsTsConfig).length > 0;
  }

  if (isGoFile(importerFileId)) {
    return goPackageDirectory(source, goConfig) !== null;
  }

  if (isRustFile(importerFileId)) {
    return source.startsWith("crate::") || source.startsWith("super::") || !source.includes("::");
  }

  return shouldResolveAbsoluteImport(importerFileId);
}
