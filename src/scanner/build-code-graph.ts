import path from "node:path";
import os from "node:os";
import { GraphBuilder } from "../graph/builder.js";
import { parseSourceFile } from "../parsers/index.js";
import type { GraphNode, GraphRelationship } from "../graph/model.js";
import { addDirectoryChain } from "./directory-graph.js";
import { discoverFiles } from "./discover-files.js";
import { addImportResolutionRelationships } from "./import-resolver.js";
import { addCallResolutionRelationships } from "./call-resolver.js";
import { detectLanguage } from "./language.js";
import {
  createScanFailure,
  createScanReport,
  type ScanReport,
} from "./report.js";

export type BuildCodeGraphOptions = {
  continueOnError: boolean;
  concurrency?: number;
  maxFiles?: number;
  include?: string[];
  exclude?: string[];
  onProgress?: (current: number, total: number, relativePath: string) => void;
};

export type BuildCodeGraphResult = {
  rootPath: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  report: ScanReport;
};

type SupportedSourceFile = {
  filePath: string;
  language: NonNullable<ReturnType<typeof detectLanguage>>;
};

type ParseResult =
  | { ok: true; parsed: Awaited<ReturnType<typeof parseSourceFile>>; filePath: string }
  | { ok: false; error: unknown; filePath: string };

export async function buildCodeGraph(
  projectPath: string,
  options: BuildCodeGraphOptions,
): Promise<BuildCodeGraphResult> {
  const rootPath = path.resolve(projectPath);
  const repoNodeId = `repo:${rootPath}`;
  const files = await discoverFiles(rootPath, {
    include: options.include,
    exclude: options.exclude,
  });

  let supportedFiles = files
    .map((filePath) => ({ filePath, language: detectLanguage(filePath) }))
    .filter((file): file is SupportedSourceFile => file.language !== null);

  if (options.maxFiles !== undefined && options.maxFiles > 0) {
    supportedFiles = supportedFiles.slice(0, options.maxFiles);
  }

  const graph = new GraphBuilder();
  const report = createScanReport(files.length, supportedFiles.length);
  const concurrency = options.concurrency ?? os.availableParallelism();

  graph.addNode({
    id: repoNodeId,
    label: "Repo",
    properties: {
      path: rootPath,
      name: path.basename(rootPath),
    },
  });

  let progressCount = 0;
  const parseResults = await runWithConcurrency(
    supportedFiles,
    concurrency,
    async ({ filePath, language }): Promise<ParseResult> => {
      const current = ++progressCount;
      options.onProgress?.(current, supportedFiles.length, path.relative(rootPath, filePath));
      try {
        const parsed = await parseFileWithContext(rootPath, filePath, language);
        return { ok: true, parsed, filePath };
      } catch (error) {
        return { ok: false, error, filePath };
      }
    },
  );

  for (const result of parseResults) {
    if (result.ok) {
      const directoryNodeId = addDirectoryChain(graph, repoNodeId, rootPath, path.dirname(result.filePath));
      graph.addNodes(result.parsed.nodes);
      graph.addRelationships(result.parsed.relationships);
      graph.addRelationship({
        from: directoryNodeId,
        to: result.parsed.fileNodeId,
        type: "CONTAINS_FILE",
        properties: {},
      });
      report.parsedFiles += 1;
    } else {
      report.failedFiles.push(createScanFailure(rootPath, result.filePath, result.error));
      if (!options.continueOnError) {
        return createResult(rootPath, graph, report);
      }
    }
  }

  const resolvedImports = await addImportResolutionRelationships(graph, rootPath);
  report.resolvedImports = resolvedImports.resolved;
  report.unresolvedRelativeImports = resolvedImports.unresolved;

  addCallResolutionRelationships(graph);

  return createResult(rootPath, graph, report);
}

function createResult(
  rootPath: string,
  graph: GraphBuilder,
  report: ScanReport,
): BuildCodeGraphResult {
  return {
    rootPath,
    nodes: graph.nodes,
    relationships: graph.relationships,
    report,
  };
}

async function parseFileWithContext(
  rootPath: string,
  filePath: string,
  language: Parameters<typeof parseSourceFile>[2],
): ReturnType<typeof parseSourceFile> {
  try {
    return await parseSourceFile(rootPath, filePath, language);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${filePath}: ${message}`, { cause: error });
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]!);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
