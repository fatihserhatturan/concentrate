import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import { addDirectoryChain } from "./directory-graph.js";
import { classifyFile } from "./file-classification.js";
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
      addParsedFileToGraph(graph, repoNodeId, rootPath, result, report);
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
  report: ScanReport,
): void {
  const directoryNodeId = addDirectoryChain(graph, repoNodeId, rootPath, path.dirname(result.filePath));
  const relativePath = path.relative(rootPath, result.filePath);
  const classification = classifyFile(relativePath);
  for (const node of result.parsed.nodes) {
    if (node.id !== result.parsed.fileNodeId || node.label !== "File") continue;
    node.properties = {
      ...node.properties,
      ...classification,
    };
    break;
  }
  report.fileClassifications[classification.sourceType] += 1;
  graph.addNodes(result.parsed.nodes);
  graph.addRelationships(result.parsed.relationships);
  graph.addRelationship({
    from: directoryNodeId,
    to: result.parsed.fileNodeId,
    type: "CONTAINS_FILE",
    properties: {},
  });
}
