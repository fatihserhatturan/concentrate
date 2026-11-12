import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGitHooks, scanShellCommand } from "./init-hooks.js";

export type McpClient = "claude" | "cursor" | "codex";
export const MCP_CLIENTS: readonly McpClient[] = ["claude", "cursor", "codex"];

export type InitAdapterOptions = {
  database?: string;
  client: string[];
  npx: boolean;
  // Also install git hooks (post-commit, post-checkout, post-merge) that rescan in the background.
  hooks?: boolean;
};

export type McpServerEntry = { command: string; args: string[] };

const SERVER_NAME = "concentrate";

// Project-level config file of each client, relative to the project root.
const CONFIG_FILES: Record<McpClient, string> = {
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  codex: ".codex/config.toml",
};

// The command a client runs to start the server: this build's CLI under the
// current Node by default, so it works without a published package;
// `npx -y concentrate` with `npx`.
export function mcpServerEntry(databasePath: string, options: { npx: boolean; cliPath?: string }): McpServerEntry {
  const mcpArgs = ["mcp", "--database", databasePath];
  if (options.npx) return { command: "npx", args: ["-y", "concentrate", ...mcpArgs] };
  const cliPath = options.cliPath ?? fileURLToPath(new URL("../../index.js", import.meta.url));
  return { command: process.execPath, args: [cliPath, ...mcpArgs] };
}

// Claude Code's `.mcp.json` and Cursor's `.cursor/mcp.json`: `mcpServers`
// keyed by name. Other servers and keys are kept.
export function mergeJsonConfig(existing: string | null, entry: McpServerEntry, file = "config"): string {
  let config: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    const parsed = JSON.parse(existing) as unknown;
    if (!isObject(parsed)) throw new Error(`${file} is not a JSON object`);
    config = parsed;
  }
  const servers = config.mcpServers === undefined ? {} : config.mcpServers;
  if (!isObject(servers)) throw new Error(`${file}: mcpServers is not an object`);
  config.mcpServers = { ...servers, [SERVER_NAME]: { command: entry.command, args: entry.args } };
  return `${JSON.stringify(config, null, 2)}\n`;
}

// Codex's `.codex/config.toml`: the `[mcp_servers.concentrate]` table is
// replaced (with its subtables) or appended; the rest of the file is kept.
export function mergeCodexToml(existing: string | null, entry: McpServerEntry): string {
  const table = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
  ].join("\n");
  const lines = (existing ?? "").split("\n");
  const header = (line: string) => /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/u.exec(line)?.[1]?.replace(/\s+/gu, "") ?? null;
  const ours = (name: string) => name === `mcp_servers.${SERVER_NAME}` || name.startsWith(`mcp_servers.${SERVER_NAME}.`)
    || name === `mcp_servers."${SERVER_NAME}"` || name.startsWith(`mcp_servers."${SERVER_NAME}".`);
  const kept: string[] = [];
  let skipping = false;
  let insertAt = -1;
  for (const line of lines) {
    const name = header(line);
    if (name !== null) {
      skipping = ours(name);
      if (skipping && insertAt === -1) insertAt = kept.length;
    }
    if (!skipping) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  if (insertAt === -1 || insertAt >= kept.length) {
    return `${kept.length > 0 ? `${kept.join("\n")}\n\n` : ""}${table}\n`;
  }
  const before = kept.slice(0, insertAt);
  while (before.length > 0 && before[before.length - 1]!.trim() === "") before.pop();
  return `${before.length > 0 ? `${before.join("\n")}\n\n` : ""}${table}\n\n${kept.slice(insertAt).join("\n")}\n`;
}

export async function runInitAdapter(projectPath: string, options: InitAdapterOptions): Promise<void> {
  const root = path.resolve(projectPath);
  const clients = options.client.length > 0 ? options.client : [...MCP_CLIENTS];
  const unknown = clients.filter((client) => !MCP_CLIENTS.includes(client as McpClient));
  if (unknown.length > 0) throw new Error(`Unknown client ${unknown.join(", ")}; use ${MCP_CLIENTS.join(", ")}`);

  const databasePath = options.database ? path.resolve(options.database) : path.join(root, ".concentrate/graph");
  const entry = mcpServerEntry(databasePath, { npx: options.npx });
  for (const client of new Set(clients as McpClient[])) {
    const file = path.join(root, CONFIG_FILES[client]);
    const existing = existsSync(file) ? await readFile(file, "utf8") : null;
    const text = client === "codex" ? mergeCodexToml(existing, entry) : mergeJsonConfig(existing, entry, file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    console.log(`${existing === null ? "wrote" : "updated"} ${displayPath(file)} (${client})`);
  }
  if (options.hooks) {
    const cliPath = fileURLToPath(new URL("../../index.js", import.meta.url));
    for (const hook of await installGitHooks(root, scanShellCommand({ root, database: databasePath, npx: options.npx, cliPath }))) {
      console.log(`${hook.created ? "wrote" : "updated"} ${displayPath(hook.file)} (git ${hook.name} hook)`);
    }
  }
  if (clients.includes("codex")) console.log("Codex reads .codex/config.toml only in projects it trusts.");
  if (!existsSync(databasePath)) {
    console.log(`No graph at ${databasePath} yet; scan the project first:\n  concentrate scan ${projectPath} --database ${databasePath}`);
  }
}

// Relative to the working directory when inside it.
function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

// TOML basic strings use JSON's escapes.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
