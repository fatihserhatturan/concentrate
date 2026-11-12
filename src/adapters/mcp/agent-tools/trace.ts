import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalInteger, optionalString, requiredString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { describeFunction, loadFunctions, type FunctionInfo } from "./graph.js";

// trace_calls: what a function calls, and how one function reaches another.
// Edges are the resolved calls (caller to callee). Each hop carries how its
// link was made (`provenance`, only when it is not exact), and a path says
// its weakest link, so an agent knows when a chain rests on an inferred step.

type Edge = { caller: string; callee: string; line: number | null; provenance: string };
type Row = Record<string, unknown>;

const STRENGTH = ["by-name", "inferred", "framework", "exact"] as const;
const MAX_PATHS = 5;

async function loadEdges(engine: IQueryEngine): Promise<Edge[]> {
  const rows = await engine.query(`
    MATCH (caller:Function)-[:CALLS]->(call:Call)-[resolved:CALL_RESOLVES_TO]->(callee:Function)
    RETURN id(caller) AS caller, id(callee) AS callee, call.line AS line, resolved.provenance AS provenance
  `) as Row[];
  return rows.map((row) => ({
    caller: String(row.caller),
    callee: String(row.callee),
    line: typeof row.line === "number" ? row.line : null,
    provenance: typeof row.provenance === "string" ? row.provenance : "exact",
  }));
}

// `name` or `Class.method`, optionally narrowed to a file.
function select(functions: Map<string, FunctionInfo>, name: string, file: string | undefined): string[] {
  const dot = name.lastIndexOf(".");
  const [className, member] = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [null, name];
  return [...functions.values()]
    .filter((fn) => fn.name === member && (!className || fn.className === className) && (!file || (fn.file !== null && (fn.file === file || fn.file.endsWith(`/${file}`)))))
    .map((fn) => fn.id);
}

export async function traceCalls(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const from = requiredString(args.from, "from");
  const to = optionalString(args.to);
  const maxDepth = optionalInteger(args.maxDepth, to ? 8 : 3, 1, 20);
  const file = optionalString(args.file);
  const toFile = optionalString(args.toFile);

  const [functions, edges] = await Promise.all([loadFunctions(engine), loadEdges(engine)]);
  const seeds = select(functions, from, file);
  if (seeds.length === 0) {
    return { from, to: to ?? null, note: "No function or method matched `from`. Use find_definitions or search_symbols to look the name up." };
  }
  const describe = (id: string) => describeFunction(functions.get(id), id);
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) outgoing.set(edge.caller, [...outgoing.get(edge.caller) ?? [], edge]);
  const hop = (edge: Edge) => ({ ...describe(edge.callee), line: edge.line, ...(edge.provenance !== "exact" ? { provenance: edge.provenance } : {}) });

  if (!to) {
    // Breadth-first down the calls: every function reached, nearest first.
    const depth = new Map<string, number>(seeds.map((id) => [id, 0]));
    const via = new Map<string, Edge>();
    let frontier = seeds;
    for (let level = 1; level <= maxDepth && frontier.length > 0; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of outgoing.get(id) ?? []) {
          if (depth.has(edge.callee)) continue;
          depth.set(edge.callee, level);
          via.set(edge.callee, edge);
          next.push(edge.callee);
        }
      }
      frontier = next;
    }
    const callees = [...via.entries()]
      .map(([id, edge]) => ({ ...hop(edge), depth: depth.get(id)!, calledBy: describe(edge.caller).name }))
      .sort((a, b) => a.depth - b.depth || String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0));
    return { from, maxDepth, seeds: seeds.length, callees: window.take(callees) };
  }

  const targets = new Set(select(functions, to, toFile));
  if (targets.size === 0) {
    return { from, to, note: "No function or method matched `to`. Use find_definitions or search_symbols to look the name up." };
  }
  // Shortest chains: a walk from each seed that stops at the first targets it meets.
  const paths: Edge[][] = [];
  for (const seed of seeds) {
    if (targets.has(seed)) continue;
    const parent = new Map<string, Edge | null>([[seed, null]]);
    let frontier = [seed];
    for (let level = 0; level < maxDepth && frontier.length > 0 && paths.length < MAX_PATHS * 4; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of outgoing.get(id) ?? []) {
          if (parent.has(edge.callee)) continue;
          parent.set(edge.callee, edge);
          if (targets.has(edge.callee)) {
            const chain: Edge[] = [];
            for (let at: Edge | null | undefined = edge; at; at = parent.get(at.caller)) chain.unshift(at);
            paths.push(chain);
          } else {
            next.push(edge.callee);
          }
        }
      }
      frontier = next;
    }
  }
  paths.sort((a, b) => a.length - b.length);
  const shown = paths.slice(0, MAX_PATHS).map((chain) => {
    const weakest = STRENGTH.find((strength) => chain.some((edge) => edge.provenance === strength)) ?? "exact";
    return {
      calls: chain.length,
      weakest,
      path: [describe(chain[0]!.caller), ...chain.map(hop)],
    };
  });
  return {
    from,
    to,
    maxDepth,
    found: shown.length > 0,
    paths: shown,
    ...(shown.length === 0 ? { note: `No chain of resolved calls up to ${maxDepth} levels. Unresolved calls (dynamic dispatch, callbacks) are not followed; try find_callers on \`to\`.` } : {}),
  };
}
