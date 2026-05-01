import path from "node:path";
import os from "node:os";
import { GraphBuilder } from "../graph/builder.js";
import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "./build-code-graph-types.js";
import { runWithConcurrency } from "./concurrency.js";
import { discoverFiles } from "./discover-files.js";
import { finalizeGraphRelationships } from "./graph-finalize.js";
import { parseFileWithContext, type ParseResult } from "./parse-source.js";
import { addParseResultsToGraph } from "./parse-results.js";
import { addProjectConfigNodes } from "./project-config.js";
import {
  createScanReport,
  type ScanReport,
} from "./report.js";
import { filterSupportedSourceFiles } from "./source-files.js";
export type { BuildCodeGraphOptions, BuildCodeGraphResult } from "./build-code-graph-types.js";

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

  const supportedFiles = filterSupportedSourceFiles(files, options.maxFiles);

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
  await addProjectConfigNodes(graph, repoNodeId, rootPath);

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

  const parsedFully = addParseResultsToGraph(
    graph,
    repoNodeId,
    rootPath,
    parseResults,
    report,
    options.continueOnError,
  );
  if (!parsedFully) {
    return createResult(rootPath, graph, report);
  }

  await finalizeGraphRelationships(graph, rootPath, report);

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
