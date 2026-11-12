import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { loadCallEdges, loadFunctions, matchesFileOrDirectory } from "./graph.js";

// Test files that reach changed files. A file depends on another when it
// imports it (a resolved import) or one of its functions, methods or its
// top level calls a function defined there (a resolved call). The walk goes
// from the changed files to their dependents, up to `maxDepth` hops, and
// keeps the files the graph marks as tests.

export type AffectedTest = {
  file: string;
  // Hops from the changed file; 0 is a changed test file itself.
  depth: number;
  // The changed file it was reached from.
  via: string;
};

export type AffectedResult = {
  // Scanned files the arguments selected.
  changed: string[];
  // Arguments that matched no scanned file (new, unsupported or excluded).
  unmatched: string[];
  tests: AffectedTest[];
};

export async function affectedTests(engine: IQueryEngine, requested: readonly string[], maxDepth = 20): Promise<AffectedResult> {
  const [fileRows, testRows, imports, moduleCalls, functions, calls] = await Promise.all([
    engine.query("MATCH (file:File) RETURN file.relativePath AS file"),
    engine.query("MATCH (file:File) WHERE file.isTest = true RETURN file.relativePath AS file"),
    engine.query(`
      MATCH (source:File)-[:IMPORTS]->(:Import)-[:RESOLVES_TO]->(target:File)
      RETURN source.relativePath AS dependent, target.relativePath AS dependency
    `),
    engine.query(`
      MATCH (source:File)-[:MODULE_CALLS]->(:Call)-[:CALL_RESOLVES_TO]->(fn:Function)
      RETURN source.relativePath AS dependent, id(fn) AS fn
    `),
    loadFunctions(engine),
    loadCallEdges(engine),
  ]) as [Array<{ file?: unknown }>, Array<{ file?: unknown }>, Array<Record<string, unknown>>, Array<Record<string, unknown>>, Awaited<ReturnType<typeof loadFunctions>>, Awaited<ReturnType<typeof loadCallEdges>>];

  const scanned = fileRows.map((row) => String(row.file));
  const isTest = new Set(testRows.map((row) => String(row.file)));

  // dependency -> files that depend on it
  const dependents = new Map<string, Set<string>>();
  const link = (dependent: unknown, dependency: unknown) => {
    if (typeof dependent !== "string" || typeof dependency !== "string" || dependent === dependency) return;
    const set = dependents.get(dependency) ?? new Set<string>();
    set.add(dependent);
    dependents.set(dependency, set);
  };
  for (const row of imports) link(row.dependent, row.dependency);
  for (const row of moduleCalls) link(row.dependent, functions.get(String(row.fn))?.file);
  for (const edge of calls) link(functions.get(edge.caller)?.file, functions.get(edge.callee)?.file);

  const changed = new Set<string>();
  const unmatched: string[] = [];
  for (const argument of requested) {
    const matches = scanned.filter((file) => matchesFileOrDirectory(file, argument));
    if (matches.length === 0) unmatched.push(argument);
    for (const file of matches) changed.add(file);
  }

  const reached = new Map<string, AffectedTest>();
  for (const root of [...changed].sort()) {
    let frontier = [root];
    const seen = new Set([root]);
    for (let depth = 0; frontier.length > 0 && depth <= maxDepth; depth += 1) {
      const next: string[] = [];
      for (const file of frontier) {
        const known = reached.get(file);
        if (isTest.has(file) && (!known || depth < known.depth)) reached.set(file, { file, depth, via: root });
        for (const dependent of dependents.get(file) ?? []) {
          if (seen.has(dependent)) continue;
          seen.add(dependent);
          next.push(dependent);
        }
      }
      frontier = next;
    }
  }

  return {
    changed: [...changed].sort(),
    unmatched,
    tests: [...reached.values()].sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file)),
  };
}
