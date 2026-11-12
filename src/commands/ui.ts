import { runUiAdapter, type UiAdapterOptions } from "../adapters/cli/index.js";

type UiOptions = { port?: number; open?: boolean };

export async function uiCommand(options: UiOptions): Promise<void> {
  const adapterOptions: UiAdapterOptions = { port: options.port, open: options.open !== false };
  const exitCode = await runUiAdapter(adapterOptions);
  if (exitCode !== 0) process.exitCode = exitCode;
}
