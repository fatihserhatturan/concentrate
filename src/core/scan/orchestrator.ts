import os from "node:os";
import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import { runWithConcurrency } from "./concurrency.js";
import { discoverFiles } from "./discover-files.js";
import { finalizeGraphRelationships } from "./graph-finalize.js";
import { parseFileWithContext, type ParseResult } from "./parse-source.js";
import { addParseResultsToGraph } from "./parse-results.js";
import { addProjectConfigNodes } from "./project-config.js";
import {
  compareScanManifests,
  createScanManifest,
  readScanManifest,
  type ScanManifest,
} from "./manifest.js";
import { filterSupportedSourceFiles } from "./source-files.js";
import { addWorkspacePackageGraph } from "./workspace-packages.js";
import type { IScanOrchestrator } from "../contracts/scan-orchestrator.js";
import type { ILanguageParser } from "../contracts/language-parser.js";
import type { ILanguageResolver } from "../contracts/language-resolver.js";
import type { ISemanticContributor } from "../contracts/semantic-contributor.js";
import { createParsePlan } from "./parse-plan.js";
import type { ScanReport } from "./report.js";
import { createScanReport } from "./report.js";
import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "./result.js";

export interface ScanDependencies {
  getParser: (language: string) => ILanguageParser;
  resolvers: readonly ILanguageResolver[];
  contributors: readonly ISemanticContributor[];
}

export function createScanOrchestrator(deps: ScanDependencies): IScanOrchestrator {
  return { buildGraph: (projectPath, options) => buildCodeGraph(projectPath, options, deps) };
}

export async function buildCodeGraph(
  projectPath: string,
  options: BuildCodeGraphOptions,
  deps: ScanDependencies,
): Promise<BuildCodeGraphResult> {
  const rootPath = path.resolve(projectPath);
  const repoNodeId = `repo:${rootPath}`;
  const files = await discoverFiles(rootPath, {
    include: options.include,
    exclude: options.exclude,
  });

  const supportedFiles = filterSupportedSourceFiles(files, options.maxFiles);
  const manifest = await createScanManifest(rootPath, supportedFiles);

  const graph = new GraphBuilder();
  const report = createScanReport(files.length, supportedFiles.length);
  if (options.previousManifestPath) {
    try {
      const previousManifest = await readScanManifest(options.previousManifestPath);
      report.incremental = compareScanManifests(manifest, previousManifest, path.resolve(options.previousManifestPath));
    } catch (error) {
      report.incremental = {
        ...report.incremental,
        checked: true,
        compatible: false,
        previousManifestPath: path.resolve(options.previousManifestPath),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  report.parsePlan = createParsePlan(
    supportedFiles,
    report.incremental,
    options.incrementalMode ?? "full",
  );
  const concurrency = options.concurrency ?? os.availableParallelism();

  graph.addNode({
    id: repoNodeId,
    label: "Repo",
    properties: {
      path: rootPath,
      name: path.basename(rootPath),
    },
  });
  await addProjectConfigNodes(graph, repoNodeId, rootPath, report);

  let progressCount = 0;
  const parseResults = await runWithConcurrency(
    supportedFiles,
    concurrency,
    async ({ filePath, language }): Promise<ParseResult> => {
      const current = ++progressCount;
      options.onProgress?.(current, supportedFiles.length, path.relative(rootPath, filePath));
      try {
        const parser = deps.getParser(language);
        const parsed = await parseFileWithContext(rootPath, filePath, language, parser);
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
    report.status = "failed";
    return createResult(rootPath, graph, report, manifest);
  }

  await addWorkspacePackageGraph(graph, repoNodeId, rootPath, report);
  await finalizeGraphRelationships(graph, rootPath, report, deps.resolvers, deps.contributors);
  report.status = report.failedFiles.length > 0 ? "partial" : "success";

  return createResult(rootPath, graph, report, manifest);
}

function createResult(
  rootPath: string,
  graph: GraphBuilder,
  report: ScanReport,
  manifest: ScanManifest,
): BuildCodeGraphResult {
  return {
    rootPath,
    nodes: graph.nodes,
    relationships: graph.relationships,
    report,
    manifest,
  };
}
