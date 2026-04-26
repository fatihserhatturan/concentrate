import path from "node:path";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";
import { printScanReport } from "../cli/report.js";
import { ProgressReporter } from "../cli/progress.js";
import { buildCodeGraph } from "../scanner/build-code-graph.js";
import { didFailFast } from "../scanner/report.js";

type ScanOptions = {
  database: string;
  continueOnError: boolean;
  concurrency?: number;
  maxFiles?: number;
  include: string[];
  exclude: string[];
};

export async function scanCommand(projectPath: string, options: ScanOptions): Promise<void> {
  const databasePath = path.resolve(options.database);
  const progress = new ProgressReporter();

  const result = await buildCodeGraph(projectPath, {
    continueOnError: options.continueOnError,
    concurrency: options.concurrency,
    maxFiles: options.maxFiles,
    include: options.include.length > 0 ? options.include : undefined,
    exclude: options.exclude.length > 0 ? options.exclude : undefined,
    onProgress: (current, total, relativePath) => {
      progress.update(current, total, relativePath);
    },
  });

  progress.clear();

  if (didFailFast(result)) {
    printScanReport(result.report, result.nodes.length, result.relationships.length, databasePath);
    process.exitCode = 1;
    return;
  }

  const writer = await KuzuGraphWriter.open(databasePath);
  await writer.reset();
  await writer.write(result.nodes, result.relationships);
  await writer.close();

  printScanReport(result.report, result.nodes.length, result.relationships.length, databasePath);
}
