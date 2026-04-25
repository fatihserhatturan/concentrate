import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";
import { parseSourceFile } from "../parsers/index.js";
import type { GraphNode, GraphRelationship } from "../graph/model.js";
import { addDirectoryChain } from "./directory-graph.js";
import { discoverFiles } from "./discover-files.js";
import { addImportResolutionRelationships } from "./import-resolver.js";
import { detectLanguage } from "./language.js";
import {
  createScanFailure,
  createScanReport,
  type ScanReport,
} from "./report.js";

export type BuildCodeGraphOptions = {
  continueOnError: boolean;
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

export async function buildCodeGraph(
  projectPath: string,
  options: BuildCodeGraphOptions,
): Promise<BuildCodeGraphResult> {
  const rootPath = path.resolve(projectPath);
  const repoNodeId = `repo:${rootPath}`;
  const files = await discoverFiles(rootPath);
  const supportedFiles = files
    .map((filePath) => ({ filePath, language: detectLanguage(filePath) }))
    .filter((file): file is SupportedSourceFile => file.language !== null);
  const graph = new GraphBuilder();
  const report = createScanReport(files.length, supportedFiles.length);

  graph.addNode({
    id: repoNodeId,
    label: "Repo",
    properties: {
      path: rootPath,
      name: path.basename(rootPath),
    },
  });

  for (const { filePath, language } of supportedFiles) {
    try {
      const parsed = await parseFileWithContext(rootPath, filePath, language);
      const directoryNodeId = addDirectoryChain(graph, repoNodeId, rootPath, path.dirname(filePath));

      graph.addNodes(parsed.nodes);
      graph.addRelationships(parsed.relationships);
      graph.addRelationship({
        from: directoryNodeId,
        to: parsed.fileNodeId,
        type: "CONTAINS_FILE",
        properties: {},
      });

      report.parsedFiles += 1;
    } catch (error) {
      report.failedFiles.push(createScanFailure(rootPath, filePath, error));

      if (!options.continueOnError) {
        return createResult(rootPath, graph, report);
      }
    }
  }

  const resolvedImports = addImportResolutionRelationships(graph);
  report.resolvedImports = resolvedImports.resolved;
  report.unresolvedRelativeImports = resolvedImports.unresolved;

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
