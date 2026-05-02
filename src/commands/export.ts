import { runExportAdapter, type ExportAdapterOptions } from "../adapters/cli/index.js";

type ExportOptions = ExportAdapterOptions;

export async function exportCommand(projectPath: string, options: ExportOptions): Promise<void> {
  const result = await runExportAdapter(projectPath, options);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}
