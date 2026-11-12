import { runNudgeAdapter, type NudgeAdapterOptions } from "../adapters/cli/index.js";

export async function nudgeCommand(options: NudgeAdapterOptions): Promise<void> {
  await runNudgeAdapter(options);
}
