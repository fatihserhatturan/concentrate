import path from "node:path";
import { defaultKuzuRetryOptions } from "../../graph/kuzu-retry.js";
import { KuzuGraphWriter } from "../kuzu/index.js";

export type StatsAdapterOptions = {
  database: string;
  package?: string;
  retryLock: boolean;
};

export async function runStatsAdapter(options: StatsAdapterOptions): Promise<void> {
  const writer = await KuzuGraphWriter.open(path.resolve(options.database), {
    retry: options.retryLock !== false ? defaultKuzuRetryOptions : false,
  });
  let version: number | null;
  let stats: Array<{ table: string; count: unknown }>;
  try {
    version = await writer.schemaVersion();
    stats = await writer.stats({ packageName: options.package });
  } finally {
    await writer.close();
  }

  console.log(`Schema version: ${version ?? "unknown"}`);
  if (options.package) {
    console.log(`Package filter: ${options.package}`);
  }
  console.table(stats);
}
