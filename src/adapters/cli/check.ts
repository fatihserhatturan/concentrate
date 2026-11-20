import path from "node:path";
import { openGraphStore } from "../../composition/graph-store.js";
import type { IGraphStore } from "../../core/contracts/graph-store.js";
import { checkCycles, checkVerdict, MAX_LISTED_FINDINGS } from "../../core/queries/check.js";
import { findImportCycles } from "../../core/queries/cycles.js";
import { findUnusedExports } from "../../core/queries/unused.js";
import { nodeSourceReader } from "../fs/source-reader.js";
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

async function withStore<T>(database: string, run: (store: IGraphStore) => Promise<T>): Promise<T> {
  const store = await openGraphStore(path.resolve(database));
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}

export async function runCyclesAdapter(options: CyclesAdapterOptions): Promise<CliAdapterResult> {
  const scope = options.scope ?? "file";
  if (scope !== "file" && scope !== "package") throw new Error(`Unknown scope ${JSON.stringify(scope)}; expected file or package`);
  const result = await withStore(options.database, (store) => findImportCycles(store, { scope, path: options.path }));
  const check = checkCycles(result, { includeTypeOnly: options.includeTypeOnly, max: options.max });
  const exitCode = check.exceeded ? 1 : 0;
  const total = check.count;
  const MAX_LISTED_MEMBERS = 30;
  if (options.json) {
    // The same entry shape the MCP tool lists: members capped per group.
    const cycles = check.listed.map((entry) => ({
      size: entry.size,
      ...(entry.matchingMembers !== undefined ? { matchingMembers: entry.matchingMembers } : {}),
      members: entry.members.slice(0, MAX_LISTED_MEMBERS),
      ...(entry.members.length > MAX_LISTED_MEMBERS ? { moreMembers: entry.members.length - MAX_LISTED_MEMBERS } : {}),
      cycle: entry.cycle,
      ...(entry.typeOnly !== undefined ? { typeOnly: entry.typeOnly } : {}),
      ...(entry.dependencyTypes ? { dependencyTypes: entry.dependencyTypes } : {}),
    }));
    console.log(JSON.stringify({ scope: result.scope, count: total, cycles }, null, 2));
    return { exitCode };
  }
  for (const entry of check.listed) console.log(`${entry.size} ${result.scope === "package" ? "packages" : "files"}: ${entry.cycle.join(" -> ")}`);
  if (total > check.listed.length) console.log(`... and ${total - check.listed.length} more`);
  console.log(total === 0 ? "No import cycles." : `${total} import ${total === 1 ? "cycle" : "cycles"}${options.includeTypeOnly ? "" : " (type-only cycles not counted)"}.`);
  return { exitCode };
}

export async function runUnusedAdapter(options: UnusedAdapterOptions): Promise<CliAdapterResult> {
  const result = await withStore(options.database, (store) => findUnusedExports(store, nodeSourceReader, { file: options.file, includeTests: options.includeTests }));
  const { count: total, exceeded } = checkVerdict(result.unusedExports.length, options.max);
  const exitCode = exceeded ? 1 : 0;
  const listed = result.unusedExports.slice(0, MAX_LISTED_FINDINGS);
  if (options.json) {
    const strip = <T extends { id: string }>({ id: _id, ...entry }: T) => entry;
    const unusedExports = listed.map(({ usedInFile, ...entry }) => ({ ...strip(entry), ...(usedInFile ? { usedInFile: true } : {}) }));
    console.log(JSON.stringify({ count: total, unusedExports, deadFunctions: result.deadFunctions.map(strip) }, null, 2));
    return { exitCode };
  }
  for (const entry of listed) {
    console.log(`${entry.file}:${entry.line ?? "?"} ${entry.kind} ${entry.name}`);
  }
  if (total > listed.length) console.log(`... and ${total - listed.length} more`);
  console.log(total === 0 ? "No unused exports." : `${total} unused export ${total === 1 ? "candidate" : "candidates"} (check each: dynamic and outside uses are not seen).`);
  return { exitCode };
}
