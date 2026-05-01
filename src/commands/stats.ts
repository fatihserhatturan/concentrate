import path from "node:path";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";

type StatsOptions = {
  database: string;
  package?: string;
};

export async function statsCommand(options: StatsOptions): Promise<void> {
  const writer = await KuzuGraphWriter.open(path.resolve(options.database));
  const version = await writer.schemaVersion();
  const stats = await writer.stats({ packageName: options.package });
  await writer.close();

  console.log(`Schema version: ${version ?? "unknown"}`);
  if (options.package) {
    console.log(`Package filter: ${options.package}`);
  }
  console.table(stats);
}
