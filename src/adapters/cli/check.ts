import path from "node:path";
import { openGraphStore } from "../../composition/graph-store.js";
import { callMcpTool } from "../mcp/tools.js";
import type { CliAdapterResult } from "./scan.js";

// CI checks on the graph: `cycles` and `unused` print what they find and exit
// 1 when there is any (more than `--max`), 0 otherwise.

export type CheckAdapterOptions = {
  database: string;
  json?: boolean;
  // Findings allowed before the exit code is 1; lets a project start from its current count.
  max?: number;
};

export type CyclesAdapterOptions = CheckAdapterOptions & {
  scope?: string;
  path?: string;
  // Count cycles that only go through type-only imports too.
  includeTypeOnly?: boolean;
};

export type UnusedAdapterOptions = CheckAdapterOptions & {
  file?: string;
  includeTests?: boolean;
};

type Result = Record<string, any>;

async function withTool(database: string, tool: string, args: Record<string, unknown>): Promise<Result> {
  const store = await openGraphStore(path.resolve(database));
  try {
    return (await callMcpTool(store, tool, args)).structuredContent as Result;
  } finally {
    await store.close();
  }
}

const MAX_LISTED = 200;

export async function runCyclesAdapter(options: CyclesAdapterOptions): Promise<CliAdapterResult> {
  const result = await withTool(options.database, "find_import_cycles", {
    scope: options.scope,
    path: options.path,
    limit: MAX_LISTED,
  });
  const all = result.cycles as Array<{ size: number; cycle: string[]; typeOnly?: boolean }>;
  const counted = options.includeTypeOnly || result.scope === "package" ? all : all.filter((entry) => !entry.typeOnly);
  const total = options.includeTypeOnly || result.scope === "package" ? Number(result.total) : Number(result.runtimeCycles);
  const exitCode = total > (options.max ?? 0) ? 1 : 0;
  if (options.json) {
    console.log(JSON.stringify({ scope: result.scope, count: total, cycles: counted }, null, 2));
    return { exitCode };
  }
  for (const entry of counted) console.log(`${entry.size} ${result.scope === "package" ? "packages" : "files"}: ${entry.cycle.join(" -> ")}`);
  if (total > counted.length) console.log(`... and ${total - counted.length} more`);
  console.log(total === 0 ? "No import cycles." : `${total} import ${total === 1 ? "cycle" : "cycles"}${options.includeTypeOnly ? "" : " (type-only cycles not counted)"}.`);
  return { exitCode };
}

export async function runUnusedAdapter(options: UnusedAdapterOptions): Promise<CliAdapterResult> {
  const result = await withTool(options.database, "find_unused_exports", { file: options.file, includeTests: options.includeTests, limit: MAX_LISTED });
  const total = Number(result.total);
  const exitCode = total > (options.max ?? 0) ? 1 : 0;
  if (options.json) {
    console.log(JSON.stringify({ count: total, unusedExports: result.unusedExports, deadFunctions: result.deadFunctions }, null, 2));
    return { exitCode };
  }
  for (const entry of result.unusedExports as Array<{ kind: string; name: string; file: string; line: number | null }>) {
    console.log(`${entry.file}:${entry.line ?? "?"} ${entry.kind} ${entry.name}`);
  }
  if (total > (result.unusedExports as unknown[]).length) console.log(`... and ${total - (result.unusedExports as unknown[]).length} more`);
  console.log(total === 0 ? "No unused exports." : `${total} unused export ${total === 1 ? "candidate" : "candidates"} (check each: dynamic and outside uses are not seen).`);
  return { exitCode };
}
