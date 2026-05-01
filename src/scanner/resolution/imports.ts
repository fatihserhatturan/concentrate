import { GraphBuilder } from "../../graph/builder.js";
import {
  createJsTsConfiguredImportBasePaths,
  readGoResolutionConfig,
  readJsTsResolutionConfigWithWarnings,
  type GoResolutionConfig,
  type JsTsResolutionConfig,
} from "./config.js";
import {
  isGoFile,
  isJsTsFile,
  isRustFile,
  shouldResolveAbsoluteImport,
} from "./file-kind.js";
import { resolveImport } from "./import-dispatch.js";
import { createFileIndex, createImporterIndex } from "./import-indexes.js";
import path from "node:path";
import { addUniqueScanWarning, type ScanReport } from "../report.js";

export async function addImportResolutionRelationships(
  graph: GraphBuilder,
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
  const goConfig = await readGoResolutionConfig(rootPath);
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
    if (!importerFileId || !shouldAttemptResolution(source, importerFileId, jsTsConfig, goConfig)) {
      continue;
    }

    const targetFileId = resolveImport(source, importerFileId, fileIdByRelativePath, jsTsConfig, goConfig);

    if (!targetFileId) {
      unresolved += 1;
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

  if (isGoFile(importerFileId) && goConfig.moduleName) {
    return source.startsWith(`${goConfig.moduleName}/`);
  }

  if (isRustFile(importerFileId)) {
    return source.startsWith("crate::") || source.startsWith("super::") || !source.includes("::");
  }

  return shouldResolveAbsoluteImport(importerFileId);
}
