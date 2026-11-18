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
  const sink = new OrderedParseResults(graph, repoNodeId, rootPath, report, continueOnError);
  parseResults.forEach((result, index) => sink.set(index, result));
  return sink.complete;
}

/**
 * Adds parse results to the graph in file order while they arrive in any
 * order. A result waits only until the results of every file before it are
 * in, then it is added and dropped, so a scan holds a few results instead of
 * one per file (on a large repository, gigabytes of parsed nodes). The graph
 * is the same as adding every result at the end in file order.
 */
export class OrderedParseResults {
  private readonly waiting = new Map<number, ParseResult>();
  private next = 0;
  private stopped = false;

  constructor(
    private readonly graph: GraphBuilder,
    private readonly repoNodeId: string,
    private readonly rootPath: string,
    private readonly report: ScanReport,
    private readonly continueOnError: boolean,
  ) {}

  /** False once a failed file stopped the scan (without continueOnError). */
  get complete(): boolean {
    return !this.stopped;
  }

  /** The result of the file at `index`; each index from 0 up is set once. */
  set(index: number, result: ParseResult): void {
    if (this.stopped) return;
    this.waiting.set(index, result);
    for (let ready = this.waiting.get(this.next); ready !== undefined && !this.stopped; ready = this.waiting.get(this.next)) {
      this.waiting.delete(this.next);
      this.next += 1;
      this.add(ready);
    }
    if (this.stopped) this.waiting.clear();
  }

  private add(result: ParseResult): void {
    if (result.ok) {
      if (addParsedFileToGraph(this.graph, this.repoNodeId, this.rootPath, result, this.report)) this.report.parsedFiles += 1;
      return;
    }
    this.report.failedFiles.push(createScanFailure(this.rootPath, result.filePath, result.error));
    if (!this.continueOnError) this.stopped = true;
  }
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
