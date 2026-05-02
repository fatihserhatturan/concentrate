import { runScanAdapter, type ScanAdapterOptions } from "../adapters/cli/index.js";

type ScanOptions = ScanAdapterOptions;

export async function scanCommand(projectPath: string, options: ScanOptions): Promise<void> {
  const result = await runScanAdapter(projectPath, options);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}
