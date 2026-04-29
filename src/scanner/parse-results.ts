import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import { addDirectoryChain } from "./directory-graph.js";
import type { ParseResult } from "./parse-source.js";
import { createScanFailure, type ScanReport } from "./report.js";

export function addParseResultsToGraph(
  graph: GraphBuilder,
  repoNodeId: string,
  rootPath: string,
  parseResults: ParseResult[],
  report: ScanReport,
  continueOnError: boolean,
): boolean {
  for (const result of parseResults) {
    if (result.ok) {
      addParsedFileToGraph(graph, repoNodeId, rootPath, result);
      report.parsedFiles += 1;
      continue;
    }

    report.failedFiles.push(createScanFailure(rootPath, result.filePath, result.error));
    if (!continueOnError) {
      return false;
    }
  }

  return true;
}

function addParsedFileToGraph(
  graph: GraphBuilder,
  repoNodeId: string,
  rootPath: string,
  result: Extract<ParseResult, { ok: true }>,
): void {
  const directoryNodeId = addDirectoryChain(graph, repoNodeId, rootPath, path.dirname(result.filePath));
  graph.addNodes(result.parsed.nodes);
  graph.addRelationships(result.parsed.relationships);
  graph.addRelationship({
    from: directoryNodeId,
    to: result.parsed.fileNodeId,
    type: "CONTAINS_FILE",
    properties: {},
  });
}
