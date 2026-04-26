import path from "node:path";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";

type StatsOptions = {
  database: string;
};

export async function statsCommand(options: StatsOptions): Promise<void> {
  const writer = await KuzuGraphWriter.open(path.resolve(options.database));
  const version = await writer.schemaVersion();
  const stats = await writer.stats();
  await writer.close();

  console.log(`Schema version: ${version ?? "unknown"}`);
  console.table(stats);
}
