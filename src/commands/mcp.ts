import { runMcpAdapter, type McpAdapterOptions } from "../adapters/cli/index.js";

type McpOptions = McpAdapterOptions;

export async function mcpCommand(options: McpOptions): Promise<void> {
  await runMcpAdapter(options);
}
