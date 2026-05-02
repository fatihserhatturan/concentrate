import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { printScanReport } from "../cli/report.js";
import { ProgressReporter } from "../cli/progress.js";
import { buildCodeGraph } from "../scanner/build-code-graph.js";
import type { IncrementalMode } from "../scanner/parse-plan.js";
import { didFailFast, didPartiallySucceed } from "../scanner/report.js";
import type { GraphNode, GraphRelationship } from "../graph/model.js";

type ExportOptions = {
  output: string;
  continueOnError: boolean;
  concurrency?: number;
  maxFiles?: number;
  include: string[];
  exclude: string[];
  previousManifest?: string;
  incremental: string;
};

export async function exportCommand(projectPath: string, options: ExportOptions): Promise<void> {
  const outputPath = path.resolve(options.output);
  const progress = new ProgressReporter();

  const result = await buildCodeGraph(projectPath, {
    continueOnError: options.continueOnError,
    concurrency: options.concurrency,
    maxFiles: options.maxFiles,
    include: options.include.length > 0 ? options.include : undefined,
    exclude: options.exclude.length > 0 ? options.exclude : undefined,
    previousManifestPath: options.previousManifest ? path.resolve(options.previousManifest) : undefined,
    incrementalMode: parseIncrementalMode(options.incremental),
    onProgress: (current, total, relativePath) => {
      progress.update(current, total, relativePath);
    },
  });

  progress.clear();

  if (didFailFast(result)) {
    printScanReport(result.report, result.nodes.length, result.relationships.length, outputPath);
    process.exitCode = 1;
    return;
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
  await writeFile(
    path.join(outputPath, "manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8",
  );

  printExportReport(outputPath, result.nodes.length, result.relationships.length);
  printScanReport(result.report, result.nodes.length, result.relationships.length, outputPath);
  if (didPartiallySucceed(result)) {
    process.exitCode = 1;
  }
}

function parseIncrementalMode(value: string): IncrementalMode {
  if (value === "full" || value === "changed-files") {
    return value;
  }

  throw new Error(`Unsupported incremental mode: ${value}`);
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
): void {
  console.log("Export complete");
  console.log(`  Output:        ${outputPath}`);
  console.log(`  Nodes JSONL:   ${path.join(outputPath, "nodes.jsonl")}`);
  console.log(`  Rels JSONL:    ${path.join(outputPath, "relationships.jsonl")}`);
  console.log(`  Summary JSON:  ${path.join(outputPath, "summary.json")}`);
  console.log(`  Manifest JSON: ${path.join(outputPath, "manifest.json")}`);
  console.log(`  Nodes:         ${nodeCount}`);
  console.log(`  Relationships: ${relationshipCount}`);
}
