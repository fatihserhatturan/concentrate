import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { architectureOverview as computeArchitecture, type ArchitectureLevel } from "../../../core/queries/architecture.js";
import { optionalInteger, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";

// architecture_overview: args parsing and edge paging; the computation is in core.
export async function architectureOverview(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const level = optionalString(args.level) ?? "package";
  if (level !== "package" && level !== "directory" && level !== "subsystem") throw new Error(`Unknown level ${JSON.stringify(level)}; expected package, directory or subsystem`);
  const depth = optionalInteger(args.depth, 2, 1, 6);
  const overview = await computeArchitecture(engine, { level: level as ArchitectureLevel, depth });
  return { ...overview, edges: window.take(overview.edges) };
}
