import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { asObject } from "./args.js";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  McpProtocolError,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./errors.js";
import { readResource, resourceDefinitions } from "./resources.js";
import type { GraphQueryEngine } from "./tools.js";
import { callMcpTool, mcpToolDefinitions, toolErrorResult } from "./tools.js";

// A dual-era MCP server over stdio (newline-delimited JSON-RPC).
//
// Modern clients (protocol 2026-07-28) send no handshake: every request
// carries the protocol version in `params._meta`, `server/discover` describes
// the server, and each result is marked complete and names the server.
// Legacy clients (2025-11-25 and earlier) start with `initialize`; their
// requests, and requests without `_meta`, get the legacy result shapes. The
// server keeps no session state either way.

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const serverInfo = { name: "concentrate", version: "0.1.0" };
const capabilities = { tools: {}, resources: {} };

// Tool and resource lists only change with the build; resource contents
// change with every scan.
const STATIC_TTL_MS = 60 * 60 * 1000;

const instructions = [
  "Concentrate answers questions about one scanned codebase from its code graph.",
  `Start with the ${resourceDefinitions[0]!.uri} resource or graph_stats for an overview.`,
  "Use search_symbols, find_definitions, list_routes and list_entrypoints to locate code; find_references for uses; impact_of, route_details and detect_changes for what a change affects; component_tree and find_component_usages for UI components; get_symbol_source and get_file_outline to read code; architecture_overview, find_import_cycles and find_unused_exports for the whole repository.",
  "List results are paged: pass page.nextCursor back as cursor, with the other arguments unchanged, for the next page.",
].join(" ");

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
        writeResponse(null, null, { code: PARSE_ERROR, message: errorMessage(error) });
        continue;
      }

      // Notifications (no id) get no response.
      if (request.id === undefined) continue;

      try {
        const result = await handleMcpRequest(request, async () => {
          state.engine ??= await engineFactory();
          return state.engine;
        });
        writeResponse(request.id, result);
      } catch (error) {
        writeResponse(request.id, null, error instanceof McpProtocolError
          ? { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) }
          : { code: INTERNAL_ERROR, message: errorMessage(error) });
      }
    }
  } finally {
    await state.engine?.close?.();
  }
}

// Answers one request; protocol errors are thrown as McpProtocolError.
export async function handleMcpRequest(
  request: JsonRpcRequest,
  engineFactory: () => Promise<GraphQueryEngine>,
): Promise<unknown> {
  if (request === null || typeof request !== "object" || typeof request.method !== "string") {
    throw new McpProtocolError(INVALID_REQUEST, "Invalid request: method must be a string");
  }
  const params = asObject(request.params);
  const requested = asObject(params._meta)[VERSION_KEY];

  if (requested === undefined || request.method === "initialize") {
    return handleLegacy(request.method, params, engineFactory);
  }
  if (requested !== MODERN_PROTOCOL_VERSION) {
    throw new McpProtocolError(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
      supported: [MODERN_PROTOCOL_VERSION],
      requested,
    });
  }

  const result = await handleModern(request.method, params, engineFactory);
  return { ...result, resultType: "complete", _meta: { [SERVER_INFO_KEY]: serverInfo } };
}

async function handleModern(
  method: string,
  params: Record<string, unknown>,
  engineFactory: () => Promise<GraphQueryEngine>,
): Promise<Record<string, unknown>> {
  switch (method) {
    case "server/discover":
      return {
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities,
        instructions,
        ttlMs: STATIC_TTL_MS,
        cacheScope: "public",
      };
    case "tools/list":
      return { tools: mcpToolDefinitions, ttlMs: STATIC_TTL_MS, cacheScope: "public" };
    case "tools/call":
      return callTool(params, engineFactory);
    case "resources/list":
      return { resources: resourceDefinitions, ttlMs: STATIC_TTL_MS, cacheScope: "public" };
    case "resources/read":
      return { ...await readResource(await engineFactory(), resourceUri(params)), ttlMs: 0, cacheScope: "private" };
    default:
      throw new McpProtocolError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

async function handleLegacy(
  method: string,
  params: Record<string, unknown>,
  engineFactory: () => Promise<GraphQueryEngine>,
): Promise<Record<string, unknown>> {
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return {
        protocolVersion: typeof requested === "string" && LEGACY_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LEGACY_PROTOCOL_VERSIONS[0],
        capabilities,
        serverInfo,
        instructions,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: mcpToolDefinitions };
    case "tools/call":
      return callTool(params, engineFactory);
    case "resources/list":
      return { resources: resourceDefinitions };
    case "resources/read":
      return readResource(await engineFactory(), resourceUri(params));
    default:
      throw new McpProtocolError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// Tool failures are results with isError, so the model sees the message;
// an unknown tool or a malformed call stays a protocol error.
async function callTool(
  params: Record<string, unknown>,
  engineFactory: () => Promise<GraphQueryEngine>,
): Promise<Record<string, unknown>> {
  if (typeof params.name !== "string" || params.name.length === 0) {
    throw new McpProtocolError(INVALID_PARAMS, "tools/call needs a tool name");
  }
  if (params.arguments !== undefined && (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments))) {
    throw new McpProtocolError(INVALID_PARAMS, "tools/call arguments must be an object");
  }
  const engine = await engineFactory();
  try {
    return await callMcpTool(engine, params.name, params.arguments ?? {});
  } catch (error) {
    if (error instanceof McpProtocolError) throw error;
    return toolErrorResult(errorMessage(error));
  }
}

function resourceUri(params: Record<string, unknown>): string {
  if (typeof params.uri !== "string") throw new McpProtocolError(INVALID_PARAMS, "resources/read needs a uri");
  return params.uri;
}

function writeResponse(id: string | number | null, result: unknown, error?: unknown): void {
  output.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result }),
  })}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
