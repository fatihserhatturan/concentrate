import path from "node:path";
import { printScanReport } from "./report.js";
import { ProgressReporter } from "./progress.js";
import { didFailFast, didPartiallySucceed } from "../../core/scan/index.js";
import { scanIntoStore, type ScanAdapterOptions } from "../../composition/scan-into-store.js";

export type CliAdapterResult = {
  exitCode: number;
};

export async function runScanAdapter(projectPath: string, options: ScanAdapterOptions): Promise<CliAdapterResult> {
  const databasePath = path.resolve(options.database);
  const manifestPath = path.resolve(options.manifest);
  const progress = new ProgressReporter();

  const result = await scanIntoStore(projectPath, options, (current, total, relativePath) => {
    progress.update(current, total, relativePath);
  });
  progress.clear();

  printScanReport(result.report, result.nodes.length, result.relationships.length, databasePath);
  console.log(`  Manifest:        ${manifestPath}`);
  return { exitCode: didFailFast(result) || didPartiallySucceed(result) ? 1 : 0 };
}
