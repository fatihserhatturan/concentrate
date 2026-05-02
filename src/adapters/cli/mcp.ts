import path from "node:path";
import { defaultKuzuRetryOptions } from "../../graph/kuzu-retry.js";
import { KuzuGraphWriter } from "../kuzu/index.js";
import { runMcpServer } from "../mcp/index.js";

export type McpAdapterOptions = {
  database: string;
  retryLock: boolean;
};

export async function runMcpAdapter(options: McpAdapterOptions): Promise<void> {
  const databasePath = path.resolve(options.database);
  await runMcpServer(async () => KuzuGraphWriter.open(databasePath, {
    retry: options.retryLock !== false ? defaultKuzuRetryOptions : false,
  }));
}
