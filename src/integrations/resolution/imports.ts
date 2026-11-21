import type { ILanguageImportResolver, ImportResolutionContext, ImportResolutionSession } from "../../core/contracts/import-resolver.js";
import type { IGraphContributor } from "../../core/contracts/graph-contributor.js";
import { addUniqueScanWarning, type ScanReport } from "../../core/scan/report.js";
import path from "node:path";

/**
 * Links each `Import` node to the files it reaches (`RESOLVES_TO`) through the
 * first registered resolver that supports the importing file. A resolver's
 * session is built the first time an import of a file it supports is seen.
 */
export async function addImportResolutionRelationships(
  graph: IGraphContributor,
  rootPath: string,
  resolvers: readonly ILanguageImportResolver[],
  report?: ScanReport,
): Promise<{
  resolved: number;
  unresolved: number;
  /** Import id -> files of the package it names as a whole (no `RESOLVES_TO`). */
  packageImports: Map<string, readonly string[]>;
}> {
  // Through the graph's lookups: only the File and IMPORTS entries are read.
  const fileIdByRelativePath = new Map<string, string>();
  for (const node of graph.nodesWithLabel("File")) {
    const relativePath = node.properties.relativePath;
    if (typeof relativePath === "string") fileIdByRelativePath.set(relativePath.split(path.sep).join(path.posix.sep), node.id);
  }
  const importerFileIdByImportId = new Map<string, string>();
  for (const relationship of graph.relationshipsOfType("IMPORTS")) importerFileIdByImportId.set(relationship.to, relationship.from);
  const context: ImportResolutionContext = {
    graph,
    rootPath,
    fileIdByRelativePath,
    importerFileIdByImportId,
    addWarning: (warning) => {
      if (report) addUniqueScanWarning(report, warning);
    },
  };
  const sessions = new Map<ILanguageImportResolver, Promise<ImportResolutionSession>>();
  const sessionOf = (resolver: ILanguageImportResolver): Promise<ImportResolutionSession> => {
    let session = sessions.get(resolver);
    if (!session) {
      session = resolver.createSession(context);
      sessions.set(resolver, session);
    }
    return session;
  };
  for (const resolver of resolvers) {
    if (resolver.sessionWithoutImports && [...fileIdByRelativePath.values()].some((fileId) => resolver.supports(fileId))) await sessionOf(resolver);
  }
  let resolved = 0;
  let unresolved = 0;
  const packageImports = new Map<string, readonly string[]>();

  for (const node of graph.nodesWithLabel("Import")) {
    const source = node.properties.source;
    if (typeof source !== "string") continue;
    const importerFileId = importerFileIdByImportId.get(node.id);
    if (!importerFileId) continue;
    const resolver = resolvers.find((candidate) => candidate.supports(importerFileId));
    if (!resolver) continue;

    const result = (await sessionOf(resolver))(node, importerFileId, source);
    for (const targetFileId of result.fileIds) {
      graph.addRelationship({ from: node.id, to: targetFileId, type: "RESOLVES_TO", properties: {} });
    }
    if (result.packageFileIds && result.packageFileIds.length > 0) packageImports.set(node.id, result.packageFileIds);
    if (result.fileIds.length > 0 || packageImports.has(node.id)) resolved += 1;
    else if (result.expected) unresolved += 1;
  }

  return { resolved, unresolved, packageImports };
}
