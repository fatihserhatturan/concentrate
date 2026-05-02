import { runStatsAdapter, type StatsAdapterOptions } from "../adapters/cli/index.js";

type StatsOptions = StatsAdapterOptions;

export async function statsCommand(options: StatsOptions): Promise<void> {
  await runStatsAdapter(options);
}
