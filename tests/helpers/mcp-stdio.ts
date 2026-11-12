import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

export type McpResponse = { id: number; result?: any; error?: { code: number; message: string; data?: unknown } };

// Runs `concentrate mcp` from sources against a graph and talks JSON-RPC to it
// one request at a time.
export function startMcpServer(databasePath: string, extraArgs: string[] = []) {
  const cli = path.resolve("src/index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", cli, "mcp", "-d", databasePath, ...extraArgs], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  let nextId = 1;

  const send = async (method: string, params: Record<string, unknown>): Promise<McpResponse> => {
    const id = nextId++;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const { value } = await lines.next();
    const response = JSON.parse(String(value)) as McpResponse;
    assert.equal(response.id, id);
    return response;
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const response = await send(method, params);
    assert.equal(response.error, undefined, response.error?.message);
    return response.result;
  };
  const notify = (method: string, params: Record<string, unknown> = {}) => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  const close = async () => {
    child.stdin!.end();
    await new Promise((resolve) => child.once("exit", resolve));
  };
  return { send, request, notify, close };
}
