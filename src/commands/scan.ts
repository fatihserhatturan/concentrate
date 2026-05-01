import path from "node:path";
import { KuzuGraphWriter, type KuzuWriteMode } from "../graph/kuzu-writer.js";
import { printScanReport } from "../cli/report.js";
import { ProgressReporter } from "../cli/progress.js";
import { buildCodeGraph } from "../scanner/build-code-graph.js";
import { didFailFast, didPartiallySucceed } from "../scanner/report.js";

type ScanOptions = {
  database: string;
  continueOnError: boolean;
  concurrency?: number;
  maxFiles?: number;
  include: string[];
  exclude: string[];
  kuzuWriteMode: string;
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
  try {
    await writer.reset();
    await writer.write(result.nodes, result.relationships, {
      mode: parseKuzuWriteMode(options.kuzuWriteMode),
    });
  } finally {
    await writer.close();
  }

  printScanReport(result.report, result.nodes.length, result.relationships.length, databasePath);
  if (didPartiallySucceed(result)) {
    process.exitCode = 1;
  }
}

function parseKuzuWriteMode(value: string): KuzuWriteMode {
  if (value === "transaction" || value === "individual") {
    return value;
  }

  throw new Error(`Unsupported Kuzu write mode: ${value}`);
}
