import type { IQueryEngine } from "../contracts/query-engine.js";
import { describeFunction, loadCallEdgesWithProvenance, loadFunctions, type FunctionInfo, type ProvenancedCallEdge } from "./graph.js";

// trace_calls: what a function calls, and how one function reaches another.
// Edges are the resolved calls (caller to callee). Each hop carries how its
// link was made (`provenance`, only when it is not exact), and a path says
// its weakest link, so an agent knows when a chain rests on an inferred step.
//
// The traversals keep the first edge that reached each function and stop a
// path search per seed; they differ from graph.ts `walkCalls` (which keeps
// only distances), so they are not shared with it.

type Edge = ProvenancedCallEdge;

const STRENGTH = ["by-name", "inferred", "framework", "exact"] as const;
const MAX_PATHS = 5;

export type TraceOptions = {
  from: string;
  to?: string;
  maxDepth: number;
  file?: string;
  toFile?: string;
};

export type TraceHop = ReturnType<typeof describeFunction> & { line: number | null; provenance?: string };

export type TraceResult =
  | { kind: "no-from" | "no-to" }
  | { kind: "callees"; seeds: number; callees: Array<TraceHop & { depth: number; calledBy: string }> }
  | { kind: "paths"; paths: Array<{ calls: number; weakest: string; path: Array<ReturnType<typeof describeFunction> | TraceHop> }> };

// `name` or `Class.method`, optionally narrowed to a file.
function select(functions: Map<string, FunctionInfo>, name: string, file: string | undefined): string[] {
  const dot = name.lastIndexOf(".");
  const [className, member] = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [null, name];
  return [...functions.values()]
    .filter((fn) => fn.name === member && (!className || fn.className === className) && (!file || (fn.file !== null && (fn.file === file || fn.file.endsWith(`/${file}`)))))
    .map((fn) => fn.id);
}

export async function traceCalls(engine: IQueryEngine, options: TraceOptions): Promise<TraceResult> {
  const { from, to, maxDepth, file, toFile } = options;
  const [functions, edges] = await Promise.all([loadFunctions(engine), loadCallEdgesWithProvenance(engine)]);
  const seeds = select(functions, from, file);
  if (seeds.length === 0) return { kind: "no-from" };
  const describe = (id: string) => describeFunction(functions.get(id), id);
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) outgoing.set(edge.caller, [...outgoing.get(edge.caller) ?? [], edge]);
  const hop = (edge: Edge): TraceHop => ({ ...describe(edge.callee), line: edge.line, ...(edge.provenance !== "exact" ? { provenance: edge.provenance } : {}) });

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
    return { kind: "callees", seeds: seeds.length, callees };
  }

  const targets = new Set(select(functions, to, toFile));
  if (targets.size === 0) return { kind: "no-to" };
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
  return {
    kind: "paths",
    paths: paths.slice(0, MAX_PATHS).map((chain) => ({
      calls: chain.length,
      weakest: STRENGTH.find((strength) => chain.some((edge) => edge.provenance === strength)) ?? "exact",
      path: [describe(chain[0]!.caller), ...chain.map(hop)],
    })),
  };
}
