import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { findImportCycles as findCycles } from "../../../core/queries/cycles.js";
import { optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";

const MAX_LISTED_MEMBERS = 30;

// find_import_cycles: core analysis, paged, with members capped per group.
export async function findImportCycles(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const scope = optionalString(args.scope) ?? "file";
  if (scope !== "file" && scope !== "package") throw new Error(`Unknown scope ${JSON.stringify(scope)}; expected file or package`);
  const wanted = optionalString(args.path);
  const result = await findCycles(engine, { scope, path: wanted });

  const components = result.cycles.map((entry) => ({
    size: entry.size,
    ...(wanted ? { matchingMembers: entry.members.length } : {}),
    members: entry.members.slice(0, MAX_LISTED_MEMBERS),
    ...(entry.members.length > MAX_LISTED_MEMBERS ? { moreMembers: entry.members.length - MAX_LISTED_MEMBERS } : {}),
    cycle: entry.cycle,
    ...(scope === "file" ? { typeOnly: entry.typeOnly } : { dependencyTypes: entry.dependencyTypes }),
  }));

  return {
    scope,
    ...(wanted ? { path: wanted } : {}),
    total: components.length,
    ...(scope === "file" ? { runtimeCycles: result.runtimeCycles } : {}),
    cycles: window.take(components),
    note: scope === "file"
      ? "Each entry is a group of files that import each other directly or indirectly; cycle is one shortest loop through the group. typeOnly: true means every loop goes through a type-only import, which usually disappears at runtime."
      : "Each entry is a group of workspace packages that depend on each other; dependencyTypes lists the dependency kinds on the example cycle (internalImport means a source import without a manifest entry).",
    ...(wanted ? { pathNote: "Only groups with a member matching path are listed; members holds just those matching members (matchingMembers counts them, size is the whole group) and cycle runs through the first of them." } : {}),
  };
}
