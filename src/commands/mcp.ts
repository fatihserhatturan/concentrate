import path from "node:path";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";
import { defaultKuzuRetryOptions } from "../graph/kuzu-retry.js";
import { runMcpServer } from "../mcp/server.js";

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
