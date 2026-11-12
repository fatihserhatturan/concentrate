import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Steering an agent toward the graph. Agents search text first even when a
// graph tool answers in one call (docs/agent-benchmark.md), so `init` can
// also write (1) a marker-fenced section into the instruction files the
// agents read and (2) an advisory Claude Code PreToolUse hook.

export const SECTION_START = "<!-- concentrate:start -->";
export const SECTION_END = "<!-- concentrate:end -->";

const SECTION_BODY = [
  "## Code graph (Concentrate)",
  "",
  "This project is indexed by Concentrate; its MCP server `concentrate` answers structural questions from a code graph. Prefer it to grep or reading files when a text match is not the answer:",
  "",
  "- who calls or uses a symbol: `find_callers`, `find_references` (imports, re-exports, methods and injected services are resolved)",
  "- what a change affects: `impact_of`, `detect_changes`, `route_details`",
  "- which frontend code calls an API route: `api_consumers`; what reads or writes a store or table: `list_stores`, `list_tables`, `list_data_access`",
  "- env and config use: `list_env_config`; import cycles and dead code: `find_import_cycles`, `find_unused_exports`",
  "- where code lives: `search_symbols`, `find_definitions`, `list_routes`, `list_pages`, `list_entrypoints`; to read it: `get_symbol_source`, `get_file_outline`",
  "",
  "Start with `graph_stats` or the `concentrate://graph/summary` resource. Use grep for plain text (strings, comments, config values). If a result has a `stale` field, those files changed after the graph was built: read them directly.",
].join("\n");

export const SECTION = `${SECTION_START}\n${SECTION_BODY}\n${SECTION_END}`;

// The file each client's agent reads: Claude Code reads CLAUDE.md, Cursor and
// Codex read AGENTS.md.
export function instructionFile(client: string): string {
  return client === "claude" ? "CLAUDE.md" : "AGENTS.md";
}

// Replaces the fenced section in place, or appends it; text outside the
// markers is kept. A start marker without an end marker is left alone and
// the section is appended, so nothing the user wrote is cut.
export function mergeInstructions(existing: string | null): string {
  if (existing === null || existing.trim() === "") return `${SECTION}\n`;
  const start = existing.indexOf(SECTION_START);
  const end = start === -1 ? -1 : existing.indexOf(SECTION_END, start);
  if (start !== -1 && end !== -1) {
    return `${existing.slice(0, start)}${SECTION}${existing.slice(end + SECTION_END.length)}`;
  }
  return `${existing.replace(/\s+$/u, "")}\n\n${SECTION}\n`;
}

// --- Claude Code hook ------------------------------------------------------

export const HOOK_MATCHER = "Grep|Read";
const HOOK_MARKER = " nudge --database ";

export const NUDGE_MESSAGE = "A Concentrate code graph exists for this project. For who-calls, what-uses, impact, routes, tables and env questions, the concentrate MCP tools (find_callers, find_references, impact_of, route_details, list_data_access, list_env_config, search_symbols) answer in one call. Use text search for plain strings.";

export function nudgeCommand(databasePath: string, options: { npx: boolean; cliPath: string }): string {
  const quote = (value: string) => JSON.stringify(value);
  return options.npx
    ? `npx -y concentrate${HOOK_MARKER}${quote(databasePath)}`
    : `${quote(process.execPath)} ${quote(options.cliPath)}${HOOK_MARKER}${quote(databasePath)}`;
}

// `.claude/settings.json` with our PreToolUse entry added or replaced; other
// settings and other hooks are kept.
export function mergeClaudeHook(existing: string | null, command: string, file = "settings.json"): string {
  let settings: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    const parsed = JSON.parse(existing) as unknown;
    if (!isObject(parsed)) throw new Error(`${file} is not a JSON object`);
    settings = parsed;
  }
  const hooks = settings.hooks === undefined ? {} : settings.hooks;
  if (!isObject(hooks)) throw new Error(`${file}: hooks is not an object`);
  const pre = hooks.PreToolUse === undefined ? [] : hooks.PreToolUse;
  if (!Array.isArray(pre)) throw new Error(`${file}: hooks.PreToolUse is not an array`);

  const ours = (group: unknown) => isObject(group) && Array.isArray(group.hooks)
    && group.hooks.some((hook) => isObject(hook) && typeof hook.command === "string" && hook.command.includes(HOOK_MARKER));
  const entry = { matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] };
  const index = pre.findIndex(ours);
  const next = index === -1 ? [...pre, entry] : pre.map((group, at) => (at === index ? entry : group)).filter((group, at) => at === index || !ours(group));
  settings.hooks = { ...hooks, PreToolUse: next };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// What the hook prints for a tool call: nothing when there is no graph or the
// session was nudged already, else advisory context (never a denial).
export function nudgeOutput(
  input: unknown,
  options: { databasePath: string; stateDir?: string },
): string | null {
  if (!existsSync(options.databasePath)) return null;
  const sessionId = isObject(input) && typeof input.session_id === "string" ? input.session_id.replace(/[^\w-]/gu, "_") : null;
  if (sessionId) {
    const marker = path.join(options.stateDir ?? os.tmpdir(), `concentrate-nudge-${sessionId}`);
    if (existsSync(marker)) return null;
    try {
      writeFileSync(marker, "");
    } catch {
      // Without a marker the session is nudged again, which is only noise.
    }
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: NUDGE_MESSAGE } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
