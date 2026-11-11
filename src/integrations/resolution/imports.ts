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
import { readCargoConfig } from "../languages/rust/cargo.js";
import { createRustModuleTree, type RustImportRecord } from "../languages/rust/resolution.js";
import { isStyleFile, resolveStyleImport } from "../languages/plain/style-resolution.js";
import { isProtoFile, resolveProtoImport } from "../languages/plain/proto-resolution.js";
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
  const rustTree = await createRustTree(rootPath, graph, fileIdByRelativePath, importerFileIdByImportId);
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

    if (importerFileId && isProtoFile(importerFileId)) {
      const targetFileId = resolveProtoImport(source, importerFileId, fileIdByRelativePath);
      if (targetFileId) {
        graph.addRelationship({ from: node.id, to: targetFileId, type: "RESOLVES_TO", properties: {} });
        resolved += 1;
      }
      continue;
    }

    // A Rust path goes through the Cargo crates and the `mod` tree.
    if (importerFileId && isRustFile(importerFileId)) {
      const result = rustTree.resolveImport(rustImportRecord(node.properties, importerFileId));
      for (const targetFileId of result.files.map((file) => fileIdByRelativePath.get(file)).filter((id): id is string => id !== undefined)) {
        graph.addRelationship({ from: node.id, to: targetFileId, type: "RESOLVES_TO", properties: {} });
      }
      if (result.files.length > 0) resolved += 1;
      else if (result.expected) unresolved += 1;
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

  return shouldResolveAbsoluteImport(importerFileId);
}

export function rustImportRecord(properties: Record<string, unknown>, importerFileId: string): RustImportRecord {
  return {
    importerFile: importerFileId.slice("file:".length),
    source: String(properties.source),
    isModule: properties.isModule === true,
    isReExport: properties.isReExport === true,
    isWildcard: properties.isWildcard === true,
    alias: typeof properties.alias === "string" ? properties.alias : null,
    inlineModules: typeof properties.inlineModules === "string" ? JSON.parse(properties.inlineModules) as string[] : [],
    pathAttribute: typeof properties.pathAttribute === "string" ? properties.pathAttribute : null,
  };
}

async function createRustTree(
  rootPath: string,
  graph: IGraphContributor,
  fileIdByRelativePath: Map<string, string>,
  importerFileIdByImportId: Map<string, string>,
) {
  const records: RustImportRecord[] = [];
  for (const node of graph.nodes) {
    if (node.label !== "Import") continue;
    const importer = importerFileIdByImportId.get(node.id);
    if (importer && isRustFile(importer)) records.push(rustImportRecord(node.properties, importer));
  }
  const config = records.length === 0 ? { packages: [] } : await readCargoConfig(rootPath, fileIdByRelativePath.keys());
  const directories = new Map<string, string[]>();
  for (const file of fileIdByRelativePath.keys()) {
    const dir = path.posix.dirname(file);
    const list = directories.get(dir) ?? [];
    list.push(file);
    directories.set(dir, list);
  }
  const tree = createRustModuleTree(config, records, (file) => fileIdByRelativePath.has(file), (dir) => directories.get(dir) ?? [], [...fileIdByRelativePath.keys()].filter((file) => file.endsWith(".rs")));
  // The call resolver (core) cannot see the tree: each file carries its crate
  // and module path.
  for (const node of graph.nodes) {
    if (node.label !== "File" || node.properties.language !== "rust") continue;
    const info = tree.fileInfo(String(node.properties.relativePath).replaceAll("\\", "/"));
    if (!info) continue;
    node.properties.rustCrate = info.crate;
    node.properties.rustCrateName = info.crateName;
    node.properties.rustModule = info.module;
  }
  return tree;
}
