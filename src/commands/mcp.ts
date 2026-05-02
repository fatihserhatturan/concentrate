import path from "node:path";
import { KuzuGraphWriter } from "../adapters/kuzu/index.js";
import { defaultKuzuRetryOptions } from "../graph/kuzu-retry.js";
import { runMcpServer } from "../adapters/mcp/index.js";

type McpOptions = {
  database: string;
  retryLock: boolean;
};

export async function mcpCommand(options: McpOptions): Promise<void> {
  const databasePath = path.resolve(options.database);
  await runMcpServer(async () => KuzuGraphWriter.open(databasePath, {
    retry: options.retryLock !== false ? defaultKuzuRetryOptions : false,
  }));
}
