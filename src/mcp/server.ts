import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { GraphQueryEngine } from "./tools.js";
import { callMcpTool, mcpToolDefinitions } from "./tools.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

export async function runMcpServer(engineFactory: () => Promise<GraphQueryEngine>): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const state: { engine?: GraphQueryEngine } = {};

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch (error) {
        writeResponse(null, null, rpcError(-32700, errorMessage(error)));
        continue;
      }

      if (request.id === undefined && request.method?.startsWith("notifications/")) {
        continue;
      }

      try {
        const result = await handleMcpRequest(request, async () => {
          state.engine ??= await engineFactory();
          return state.engine;
        });
        if (request.id !== undefined) {
          writeResponse(request.id, result);
        }
      } catch (error) {
        if (request.id !== undefined) {
          writeResponse(request.id, null, rpcError(-32603, errorMessage(error)));
        }
      }
    }
  } finally {
    await state.engine?.close?.();
  }
}

export async function handleMcpRequest(
  request: JsonRpcRequest,
  engineFactory: () => Promise<GraphQueryEngine>,
): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "concentrate",
          version: "0.1.0",
        },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: mcpToolDefinitions };
    case "tools/call": {
      const params = asObject(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      const args = "arguments" in params ? params.arguments : {};
      return callMcpTool(await engineFactory(), name, args);
    }
    default:
      throw new Error(`Unsupported MCP method: ${request.method ?? "unknown"}`);
  }
}

function writeResponse(id: string | number | null, result: unknown, error?: unknown): void {
  output.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result }),
  })}\n`);
}

function rpcError(code: number, message: string): { code: number; message: string } {
  return { code, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
