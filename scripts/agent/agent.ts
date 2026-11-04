/**
 * Pure parts of the agent benchmark (scripts/bench-agent.ts): scoring an
 * answer, reading a `claude -p --output-format stream-json` transcript, and
 * building the command for each mode. Kept apart so tests can run them
 * without the Claude Code CLI.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export type Question = {
  id: string;
  sample: string;
  category: string;
  question: string;
  // Relative to the sample directory; the sample root when absent.
  cwd?: string;
  // A patch (relative to bench/agent/) applied to the sample's working tree
  // before each run and reverted after it, for questions about a change.
  patch?: string;
  // Tools both modes may use on top of the defaults, such as `Bash(git diff:*)`
  // for a question about the working tree.
  extraTools?: string[];
  expected: { mustInclude: string[]; anyOf?: string[][] };
};

export type Mode = "baseline" | "concentrate";
export const modes: readonly Mode[] = ["baseline", "concentrate"];

// Lowercased, without Markdown code and emphasis marks, quotes and table
// bars, whitespace collapsed: "POST `/cats`", "**post /cats**" and the table
// row "| POST | `/cats` |" read the same.
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[`*_"']/g, "").replace(/\|/g, " ").replace(/\s+/g, " ");
}

export type AnswerScore = { correct: boolean; missing: string[] };

// Correct when the answer contains every mustInclude string and at least one
// string of each anyOf group.
export function scoreAnswer(answer: string, expected: Question["expected"]): AnswerScore {
  const text = normalizeText(answer);
  const has = (needle: string) => text.includes(normalizeText(needle));
  const missing = [
    ...expected.mustInclude.filter((needle) => !has(needle)),
    ...(expected.anyOf ?? []).filter((group) => !group.some(has)).map((group) => group.join(" | ")),
  ];
  return { correct: missing.length === 0, missing };
}

export type RunMetrics = {
  answer: string;
  isError: boolean;
  turns: number;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  toolsByName: Record<string, number>;
  // Every call of a concentrate MCP tool with its input and its result,
  // truncated, so an empty or wrong graph answer shows without a rerun.
  mcpCalls: McpCall[];
};

export type McpCall = { tool: string; input: unknown; result: string; isError: boolean };

// Characters of an MCP tool result kept in the results file.
export const MCP_RESULT_CHARS = 2000;

export function truncateResult(text: string, limit = MCP_RESULT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} chars)`;
}

// Every input token the model read: fresh, written to and read from the cache.
export const totalInputTokens = (run: RunMetrics) => run.inputTokens + run.cacheCreationTokens + run.cacheReadTokens;

type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
type StreamEvent = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Usage;
  message?: { content?: ContentBlock[] };
};
type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
};

const resultText = (content: ContentBlock["content"]) => (
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n")
);

// Reads the newline-delimited events of one run: tool_use blocks of the
// assistant messages, the tool_result blocks of concentrate MCP calls in the
// user messages, and the closing `result` event with the answer, turns,
// duration, cost and token usage for the whole run.
export function parseStreamJson(transcript: string): RunMetrics {
  const toolsByName: Record<string, number> = {};
  const mcpCalls: McpCall[] = [];
  const mcpCallById = new Map<string, McpCall>();
  let result: StreamEvent | undefined;
  for (const line of transcript.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_use" || !block.name) continue;
        toolsByName[block.name] = (toolsByName[block.name] ?? 0) + 1;
        if (!block.name.startsWith(mcpPrefix)) continue;
        const call: McpCall = { tool: block.name.slice(mcpPrefix.length), input: block.input ?? {}, result: "", isError: false };
        mcpCalls.push(call);
        if (block.id) mcpCallById.set(block.id, call);
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        const call = block.type === "tool_result" && block.tool_use_id ? mcpCallById.get(block.tool_use_id) : undefined;
        if (!call) continue;
        call.result = truncateResult(resultText(block.content));
        call.isError = block.is_error === true;
      }
    } else if (event.type === "result") {
      result = event;
    }
  }
  if (!result) throw new Error("No result event in the stream-json transcript");
  const usage = result.usage ?? {};
  return {
    answer: result.result ?? "",
    isError: result.is_error === true || result.subtype !== "success",
    turns: result.num_turns ?? 0,
    durationMs: result.duration_ms ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    toolCalls: Object.values(toolsByName).reduce((total, count) => total + count, 0),
    toolsByName,
    mcpCalls,
  };
}

// Both modes can read the code; concentrate mode adds the graph's MCP tools.
export const baselineTools = ["Read", "Grep", "Glob", "Bash(ls:*)"];
export const blockedTools = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"];
export const mcpServerName = "concentrate";

export function mcpConfig(mode: Mode, cliPath: string, databasePath: string) {
  return {
    mcpServers: mode === "concentrate"
      ? { [mcpServerName]: { command: process.execPath, args: [cliPath, "mcp", "-d", databasePath] } }
      : {},
  };
}

export type CommandOptions = { mcpConfigPath: string; model?: string; maxTurns: number; extraTools?: readonly string[] };

// `claude -p` arguments for one run. --strict-mcp-config keeps the user's own
// MCP servers out of both modes.
export function claudeArgs(mode: Mode, question: string, options: CommandOptions): string[] {
  const base = [...baselineTools, ...(options.extraTools ?? [])];
  const allowed = mode === "concentrate" ? [...base, `mcp__${mcpServerName}`] : base;
  return [
    "-p", question,
    "--output-format", "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config", options.mcpConfigPath,
    "--allowedTools", allowed.join(","),
    "--disallowedTools", blockedTools.join(","),
    "--max-turns", String(options.maxTurns),
    ...(options.model ? ["--model", options.model] : []),
  ];
}

// The Claude Code CLI the desktop app ships, newest version first:
// <root>/<version>/<build>/claude.app/Contents/MacOS/claude, where root is
// ~/Library/Application Support/Claude/claude-code on macOS.
export function desktopClaudeBinaries(root: string): string[] {
  if (!existsSync(root)) return [];
  const versionParts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const newer = (a: string, b: string) => {
    const [partsA, partsB] = [versionParts(a), versionParts(b)];
    for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
      const difference = (partsB[index] ?? 0) - (partsA[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const subdirectories = (directory: string) => readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return subdirectories(root).sort(newer).flatMap((version) => (
    subdirectories(path.join(root, version))
      .map((build) => path.join(root, version, build, "claude.app/Contents/MacOS/claude"))
      .filter((binary) => existsSync(binary))
  ));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export type Range = { min: number; max: number };

export function range(values: readonly number[]): Range {
  return values.length === 0 ? { min: 0, max: 0 } : { min: Math.min(...values), max: Math.max(...values) };
}

export type ModeSummary = {
  runs: number;
  correct: number;
  medianInputTokens: number;
  medianOutputTokens: number;
  medianToolCalls: number;
  medianTurns: number;
  medianDurationMs: number;
  medianCostUsd: number;
  // Lowest and highest value over the runs, next to the medians.
  spread: { inputTokens: Range; toolCalls: Range; durationMs: Range; costUsd: Range };
  totalCostUsd: number;
  // Runs that called at least one tool of the concentrate MCP server, and
  // the calls per tool (without the `mcp__concentrate__` prefix).
  mcpRuns: number;
  mcpTools: Record<string, number>;
  // ToolSearch calls: Claude Code loads deferred MCP tool schemas through it.
  toolSearchCalls: number;
};

const mcpPrefix = `mcp__${mcpServerName}__`;
const roundCost = (value: number) => Math.round(value * 10000) / 10000;

export function summarize(runs: ReadonlyArray<RunMetrics & { correct: boolean }>): ModeSummary {
  const of = (pick: (run: RunMetrics) => number) => median(runs.map(pick));
  const spreadOf = (pick: (run: RunMetrics) => number) => range(runs.map(pick));
  const mcpTools: Record<string, number> = {};
  let mcpRuns = 0;
  let toolSearchCalls = 0;
  for (const run of runs) {
    let usedMcp = false;
    for (const [name, count] of Object.entries(run.toolsByName)) {
      if (name === "ToolSearch") toolSearchCalls += count;
      if (!name.startsWith(mcpPrefix)) continue;
      usedMcp = true;
      const tool = name.slice(mcpPrefix.length);
      mcpTools[tool] = (mcpTools[tool] ?? 0) + count;
    }
    if (usedMcp) mcpRuns += 1;
  }
  const cost = spreadOf((run) => run.costUsd);
  return {
    runs: runs.length,
    correct: runs.filter((run) => run.correct).length,
    medianInputTokens: of(totalInputTokens),
    medianOutputTokens: of((run) => run.outputTokens),
    medianToolCalls: of((run) => run.toolCalls),
    medianTurns: of((run) => run.turns),
    medianDurationMs: of((run) => run.durationMs),
    medianCostUsd: roundCost(of((run) => run.costUsd)),
    spread: {
      inputTokens: spreadOf(totalInputTokens),
      toolCalls: spreadOf((run) => run.toolCalls),
      durationMs: spreadOf((run) => run.durationMs),
      costUsd: { min: roundCost(cost.min), max: roundCost(cost.max) },
    },
    totalCostUsd: roundCost(runs.reduce((total, run) => total + run.costUsd, 0)),
    mcpRuns,
    mcpTools: Object.fromEntries(Object.entries(mcpTools).sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))),
    toolSearchCalls,
  };
}
