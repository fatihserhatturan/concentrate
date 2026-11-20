import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalInteger, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { assertValidRevision, GitChangeSource } from "../../git/change-source.js";
import { detectChanges as detectChangesQuery } from "../../../core/queries/changes.js";
import { impactOf as impactOfQuery } from "../../../core/queries/impact.js";

// impact_of: see core/queries/impact.ts. The callers list is paged by `window`.
export async function impactOf(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const symbol = optionalString(args.symbol);
  const file = optionalString(args.file);
  if (!symbol && !file) throw new Error("impact_of needs a symbol or a file argument");
  return impactOfQuery(engine, { symbol, file, maxDepth: optionalInteger(args.maxDepth, 5, 1, 20), window });
}

// detect_changes: diff the working tree against `base` (default HEAD) and
// report the declarations, tests and callers the change reaches.
export async function detectChanges(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const base = optionalString(args.base) ?? "HEAD";
  assertValidRevision(base);
  const maxDepth = optionalInteger(args.maxDepth, 5, 1, 20);
  const { limit } = window;

  const [repo] = await engine.query("MATCH (repo:Repo) RETURN repo.path AS path LIMIT 1") as Array<{ path?: unknown }>;
  if (typeof repo?.path !== "string") throw new Error("The graph has no Repo node; scan the project first");

  const result = await detectChangesQuery(engine, new GitChangeSource(), { scanPath: repo.path, base, maxDepth, limit });
  const { impact, affectedTests: tests, unscannedFiles } = result;
  return {
    base,
    changedFiles: window.take(result.changedFiles),
    affectedTests: tests.slice(0, limit).map(({ file, depth }) => ({ file, depth })),
    ...(tests.length > limit ? { affectedTestsTruncated: tests.length } : {}),
    unscannedFiles: unscannedFiles.slice(0, limit),
    ...(unscannedFiles.length > 0
      ? { note: "Some changed files are not in the graph (new, unsupported or excluded). Rescan, or keep `concentrate watch` running, to include new files." }
      : {}),
    impact: impact && { callers: impact.callers, moduleCallers: impact.moduleCallers, routes: impact.routes, entrypoints: impact.entrypoints, components: impact.components, pages: impact.pages, apiConsumers: impact.apiConsumers, consumerComponents: impact.consumerComponents, consumerPages: impact.consumerPages, stores: impact.stores, storeComponents: impact.storeComponents, storePages: impact.storePages, dataAccess: impact.dataAccess, envVars: impact.envVars, config: impact.config },
  };
}
