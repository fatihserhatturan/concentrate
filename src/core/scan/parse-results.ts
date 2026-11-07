import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import { addDirectoryChain } from "./directory-graph.js";
import { classifyFile } from "./file-classification.js";
import { isCodeLanguage, type SupportedLanguage } from "./language.js";
import type { ParseResult } from "./parse-source.js";
import { addUniqueScanWarning, createScanFailure, type ScanReport } from "./report.js";

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
      if (addParsedFileToGraph(graph, repoNodeId, rootPath, result, report)) report.parsedFiles += 1;
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
): boolean {
  const directoryNodeId = addDirectoryChain(graph, repoNodeId, rootPath, path.dirname(result.filePath));
  const relativePath = path.relative(rootPath, result.filePath);
  const fileNode = result.parsed.nodes.find((node) => node.id === result.parsed.fileNodeId && node.label === "File");
  // A parser may know the file is generated from its contents (Go's
  // `// Code generated … DO NOT EDIT.`).
  const language = fileNode?.properties.language;
  const code = typeof language !== "string" || isCodeLanguage(language as SupportedLanguage);
  const classification = classifyFile(relativePath, fileNode?.properties.isGenerated === true, code);
  for (const node of result.parsed.nodes) {
    if (node.id !== result.parsed.fileNodeId || node.label !== "File") continue;
    node.properties = {
      ...node.properties,
      ...classification,
    };
    break;
  }
  report.fileClassifications[classification.sourceType] += 1;
  for (const message of result.parsed.warnings ?? []) {
    addUniqueScanWarning(report, { path: relativePath, message });
  }
  graph.addNodes(result.parsed.nodes);
  graph.addRelationships(result.parsed.relationships);
  graph.addRelationship({
    from: directoryNodeId,
    to: result.parsed.fileNodeId,
    type: "CONTAINS_FILE",
    properties: {},
  });
  return code;
}
