import { runInitAdapter, type InitAdapterOptions } from "../adapters/cli/index.js";

type InitOptions = InitAdapterOptions;

export async function initCommand(projectPath: string, options: InitOptions): Promise<void> {
  await runInitAdapter(projectPath, options);
}
