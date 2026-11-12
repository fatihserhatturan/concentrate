import { runCyclesAdapter, runUnusedAdapter, type CyclesAdapterOptions, type UnusedAdapterOptions } from "../adapters/cli/index.js";

export async function cyclesCommand(options: CyclesAdapterOptions): Promise<void> {
  const result = await runCyclesAdapter(options);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

export async function unusedCommand(options: UnusedAdapterOptions): Promise<void> {
  const result = await runUnusedAdapter(options);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
