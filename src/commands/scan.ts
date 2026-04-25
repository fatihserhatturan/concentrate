import path from "node:path";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";
import { printScanReport } from "../cli/report.js";
import { buildCodeGraph } from "../scanner/build-code-graph.js";
import { didFailFast } from "../scanner/report.js";

type ScanOptions = {
  database: string;
  continueOnError: boolean;
};

export async function scanCommand(projectPath: string, options: ScanOptions): Promise<void> {
  const databasePath = path.resolve(options.database);
  const result = await buildCodeGraph(projectPath, {
    continueOnError: options.continueOnError,
  });

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
