import type { IQueryEngine } from "../contracts/query-engine.js";
import { callerCompleteness, computeImpact, loadFunctions, loadInterfaceMethods, matchesFileOrDirectory, type ListWindow, unresolvedCalls } from "./graph.js";
import { loadRunners } from "./runners.js";
import { isStyleFilePath, loadStyleTargets, parseStyleSymbol, styleImpact } from "./styles.js";

export type ImpactOfOptions = {
  symbol?: string;
  file?: string;
  maxDepth: number;
  // `limit` caps every list; the callers list is paged by the whole window.
  window: ListWindow;
};

// impact_of: a symbol name selects the functions with that name plus the
// methods of a class with that name, and the stores with that name or hook;
// a file selects every function in it. Both together narrow the symbol to
// that file.
export async function impactOf(engine: IQueryEngine, options: ImpactOfOptions) {
  const { symbol, file, maxDepth, window } = options;
  if (!symbol && !file) throw new Error("impact_of needs a symbol or a file argument");

  // `.btn`, `#hero`, `--color-brand`, or a style sheet alone: who uses it.
  if (parseStyleSymbol(symbol) || (!symbol && isStyleFilePath(file))) {
    const targets = await loadStyleTargets(engine, symbol, file);
    if (targets.length === 0) {
      return { symbol: symbol ?? null, file: file ?? null, styles: [], note: "No class, id or custom property matched. Use search_symbols or find_definitions to look the name up." };
    }
    return {
      symbol: symbol ?? null,
      file: file ?? null,
      maxDepth,
      ...await styleImpact(engine, targets, maxDepth, window.limit),
      note: "users: components, functions and files naming the style; match module is exact, import and name are matches by class name only. A custom property reaches the components of the style files that use it and of the files importing them.",
    };
  }

  const functions = await loadFunctions(engine);
  // A Java interface method is a valid seed: calls through the interface resolve to it.
  for (const method of await loadInterfaceMethods(engine)) if (!functions.has(method.id)) functions.set(method.id, method);
  const seedIds = [...functions.values()]
    .filter((fn) => !symbol || fn.name === symbol || fn.className === symbol)
    .filter((fn) => !file || matchesFileOrDirectory(fn.file, file))
    .map((fn) => fn.id);
  const storeRows = symbol
    ? await engine.query(`
      MATCH (file:File)-[:DECLARES_STORE]->(store:Store)
      WHERE store.name = $symbol OR store.hook = $symbol
      RETURN id(store) AS id, file.relativePath AS file
    `, { symbol }) as Array<{ id?: unknown; file?: unknown }>
    : [];
  const storeIds = storeRows.filter((row) => !file || matchesFileOrDirectory(String(row.file), file)).map((row) => String(row.id));
  // Scripts, make targets, npm scripts, compose services and CI jobs that
  // start the file (a file argument), or the files the seeds are in.
  const seedFiles = new Set(seedIds.map((id) => functions.get(id)!.file));
  const runners = await loadRunners(engine, (candidate) => (file ? matchesFileOrDirectory(candidate, file) : seedFiles.has(candidate)), maxDepth);
  const runnersOutput = runners.length > 0 ? { runners: runners.slice(0, window.limit), ...(runners.length > window.limit ? { runnersTruncated: runners.length } : {}) } : {};
  if (seedIds.length === 0 && storeIds.length === 0) {
    return {
      symbol: symbol ?? null,
      file: file ?? null,
      seeds: [],
      ...runnersOutput,
      note: runners.length > 0
        ? "No function, method, class or store matched; runners are the scripts, targets, services and jobs that start the file."
        : "No function, method, class or store matched. Use find_definitions to look the name up; for routes use route_details.",
    };
  }
  // A named symbol says whether its direct callers are all known; a whole
  // file has too many names for that.
  const names = symbol ? [...new Set(seedIds.map((id) => functions.get(id)!.name))] : [];
  return {
    symbol: symbol ?? null,
    file: file ?? null,
    maxDepth,
    ...await computeImpact(engine, seedIds, maxDepth, window.limit, functions, window, storeIds),
    ...runnersOutput,
    ...(names.length > 0 ? callerCompleteness(names, await unresolvedCalls(engine, names)) : {}),
  };
}
