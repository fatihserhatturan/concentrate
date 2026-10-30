import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { printScanReport } from "./report.js";
import { ProgressReporter } from "./progress.js";
import type { GraphNode, GraphRelationship } from "../../core/graph/model.js";
import { formatNormalizedGraph, normalizeGraph } from "../../core/graph/normalize.js";
import { didFailFast, didPartiallySucceed } from "../../core/scan/index.js";
import { scanOrchestrator } from "../../composition/orchestrator.js";
import type { CliAdapterResult } from "./scan.js";

export type ExportAdapterOptions = {
  output: string;
  continueOnError: boolean;
  concurrency?: number;
  workers?: number;
  maxFiles?: number;
  include: string[];
  exclude: string[];
  apiOrigin?: string[];
  cacheDir: string;
  cache?: boolean;
  normalized?: boolean;
};

export async function runExportAdapter(projectPath: string, options: ExportAdapterOptions): Promise<CliAdapterResult> {
  const outputPath = path.resolve(options.output);
  const progress = new ProgressReporter();

  const result = await scanOrchestrator.buildGraph(projectPath, {
    continueOnError: options.continueOnError,
    concurrency: options.concurrency,
    workers: options.workers,
    maxFiles: options.maxFiles,
    include: options.include.length > 0 ? options.include : undefined,
    exclude: options.exclude.length > 0 ? options.exclude : undefined,
    apiOrigins: options.apiOrigin,
    cacheDirectory: options.cache === false ? undefined : path.resolve(options.cacheDir),
    onProgress: (current, total, relativePath) => {
      progress.update(current, total, relativePath);
    },
  });

  progress.clear();

  if (didFailFast(result)) {
    printScanReport(result.report, result.nodes.length, result.relationships.length, outputPath);
    return { exitCode: 1 };
  }

  await mkdir(outputPath, { recursive: true });
  await writeJsonl(path.join(outputPath, "nodes.jsonl"), result.nodes);
  await writeJsonl(path.join(outputPath, "relationships.jsonl"), result.relationships);
  await writeFile(
    path.join(outputPath, "summary.json"),
    `${JSON.stringify({
      rootPath: result.rootPath,
      report: result.report,
      manifest: {
        path: "manifest.json",
        files: result.manifest.files.length,
        hashAlgorithm: result.manifest.hashAlgorithm,
      },
      nodes: result.nodes.length,
      relationships: result.relationships.length,
    }, null, 2)}\n`,
    "utf8",
  );
  if (options.normalized) {
    await writeFile(
      path.join(outputPath, "graph.normalized.jsonl"),
      formatNormalizedGraph(normalizeGraph(result)),
      "utf8",
    );
  }
  await writeFile(
    path.join(outputPath, "manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8",
  );

  printExportReport(outputPath, result.nodes.length, result.relationships.length, options.normalized === true);
  printScanReport(result.report, result.nodes.length, result.relationships.length, outputPath);
  return { exitCode: didPartiallySucceed(result) ? 1 : 0 };
}

async function writeJsonl(
  filePath: string,
  records: Array<GraphNode | GraphRelationship>,
): Promise<void> {
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(filePath, content.length > 0 ? `${content}\n` : "", "utf8");
}

function printExportReport(
  outputPath: string,
  nodeCount: number,
  relationshipCount: number,
  normalized: boolean,
): void {
  console.log("Export complete");
  console.log(`  Output:        ${outputPath}`);
  console.log(`  Nodes JSONL:   ${path.join(outputPath, "nodes.jsonl")}`);
  console.log(`  Rels JSONL:    ${path.join(outputPath, "relationships.jsonl")}`);
  console.log(`  Summary JSON:  ${path.join(outputPath, "summary.json")}`);
  console.log(`  Manifest JSON: ${path.join(outputPath, "manifest.json")}`);
  if (normalized) {
    console.log(`  Normalized:    ${path.join(outputPath, "graph.normalized.jsonl")}`);
  }
  console.log(`  Nodes:         ${nodeCount}`);
  console.log(`  Relationships: ${relationshipCount}`);
}
