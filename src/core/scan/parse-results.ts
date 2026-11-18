import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import { addDirectoryChain } from "./directory-graph.js";
import { classifyFile } from "./file-classification.js";
import { isCodeLanguage, type SupportedLanguage } from "./language.js";
import type { ParsedSourceFile } from "../graph/model.js";
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
  const classification = classifyFile(relativePath, fileNode?.properties.isGenerated === true, code, fileNode?.properties.isTest === true);
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
  shareStrings(result.parsed);
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

/**
 * Make equal strings of one parsed file one string. A file parsed in a worker
 * or read from the parse cache arrives with a separate copy of every
 * occurrence: a node's id and the `from` / `to` of each relationship that
 * touches it, and property values such as a call's `name`, `expression` and
 * `callee`, which are often the same text. On a large repository these copies
 * are a few hundred MB of the scan's live heap.
 */
function shareStrings(parsed: ParsedSourceFile): void {
  const strings = new Map<string, string>();
  const share = (value: string): string => {
    const known = strings.get(value);
    if (known !== undefined) return known;
    strings.set(value, value);
    return value;
  };
  for (const node of parsed.nodes) {
    node.id = share(node.id);
    shareProperties(node.properties, share);
  }
  for (const relationship of parsed.relationships) {
    relationship.from = share(relationship.from);
    relationship.to = share(relationship.to);
    shareProperties(relationship.properties, share);
  }
}

function shareProperties(properties: Record<string, unknown>, share: (value: string) => string): void {
  for (const key in properties) {
    const value = properties[key];
    if (typeof value === "string") properties[key] = share(value);
  }
}
