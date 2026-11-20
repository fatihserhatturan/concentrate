import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalInteger, optionalString, requiredString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { traceCalls as traceCallsCore } from "../../../core/queries/trace.js";

// trace_calls: what a function calls, and how one function reaches another.
// The computation lives in core/queries/trace.ts; this handler parses the
// arguments, words the notes and pages the callees.

export async function traceCalls(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const from = requiredString(args.from, "from");
  const to = optionalString(args.to);
  const maxDepth = optionalInteger(args.maxDepth, to ? 8 : 3, 1, 20);
  const file = optionalString(args.file);
  const toFile = optionalString(args.toFile);

  const result = await traceCallsCore(engine, { from, to, maxDepth, file, toFile });
  switch (result.kind) {
    case "no-from":
      return { from, to: to ?? null, note: "No function or method matched `from`. Use find_definitions or search_symbols to look the name up." };
    case "no-to":
      return { from, to, note: "No function or method matched `to`. Use find_definitions or search_symbols to look the name up." };
    case "callees":
      return { from, maxDepth, seeds: result.seeds, callees: window.take(result.callees) };
    case "paths":
      return {
        from,
        to,
        maxDepth,
        found: result.paths.length > 0,
        paths: result.paths,
        ...(result.paths.length === 0 ? { note: `No chain of resolved calls up to ${maxDepth} levels. Unresolved calls (dynamic dispatch, callbacks) are not followed; try find_callers on \`to\`.` } : {}),
      };
  }
}
