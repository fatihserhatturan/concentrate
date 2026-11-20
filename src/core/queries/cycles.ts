import type { IQueryEngine } from "../contracts/query-engine.js";
import { loadImports } from "./model.js";

type Row = Record<string, unknown>;

// Edge attributes per (from, to) pair; `runtime` is false when every import
// behind the edge is type-only.
type Edge = { runtime: boolean; types: Set<string> };
type Graph = Map<string, Map<string, Edge>>;

export type CycleScope = "file" | "package";

export type FindImportCyclesOptions = {
  /** `file` (default): the file import graph; `package`: the workspace package dependency graph. */
  scope?: CycleScope;
  /** A file path / package name (exact, path suffix or directory): keeps only groups with a matching member. */
  path?: string;
};

export type ImportCycle = {
  /** Members in the whole group. */
  size: number;
  /** With `path`: how many members match it. */
  matchingMembers?: number;
  /** The group's members (only the matching ones with `path`), sorted. */
  members: string[];
  /** One shortest loop through the first listed member, ending with that member again. */
  cycle: string[];
  /** File scope: every loop goes through a type-only import. */
  typeOnly?: boolean;
  /** Package scope: dependency kinds along the example cycle. */
  dependencyTypes?: string[];
};

export type ImportCyclesResult = {
  scope: CycleScope;
  path?: string;
  /** Every group, largest first. */
  cycles: ImportCycle[];
  /** File scope: groups with at least one runtime loop. */
  runtimeCycles?: number;
  /** Graph node id of each file named in `members` or `cycle` (file scope). */
  ids: Record<string, string>;
};

// Strongly connected components of the file import graph (or of the package
// dependency graph), largest first, each with one shortest cycle through its
// first member. With path, only groups that contain a matching member are
// kept, and members lists just the matching ones.
export async function findImportCycles(engine: IQueryEngine, options: FindImportCyclesOptions = {}): Promise<ImportCyclesResult> {
  const scope = options.scope ?? "file";
  if (scope !== "file" && scope !== "package") throw new Error(`Unknown scope ${JSON.stringify(scope)}; expected file or package`);
  const wanted = options.path;
  const graph = scope === "file" ? await fileGraph(engine) : await packageGraph(engine);

  const cycles = stronglyConnected(graph).flatMap((members): ImportCycle[] => {
    const listed = wanted ? members.filter((member) => matchesPath(member, wanted)) : members;
    if (listed.length === 0) return [];
    const inside = new Set(members);
    const start = listed[0]!;
    const runtimeCycle = shortestCycle(graph, start, inside, true);
    const cycle = runtimeCycle ?? shortestCycle(graph, start, inside, false)!;
    const types = new Set<string>();
    for (let index = 0; index + 1 < cycle.length; index++) {
      for (const type of graph.get(cycle[index]!)!.get(cycle[index + 1]!)!.types) types.add(type);
    }
    return [{
      size: members.length,
      ...(wanted ? { matchingMembers: listed.length } : {}),
      members: listed,
      cycle,
      ...(scope === "file" ? { typeOnly: runtimeCycle === null } : { dependencyTypes: [...types].sort() }),
    }];
  }).sort((a, b) => b.size - a.size || a.cycle[0]!.localeCompare(b.cycle[0]!));

  return {
    scope,
    ...(wanted ? { path: wanted } : {}),
    cycles,
    ...(scope === "file" ? { runtimeCycles: cycles.filter((cycle) => !cycle.typeOnly).length } : {}),
    ids: scope === "file" && cycles.length > 0 ? await fileIds(engine, cycles) : {},
  };
}

async function fileIds(engine: IQueryEngine, cycles: readonly ImportCycle[]): Promise<Record<string, string>> {
  const wanted = new Set(cycles.flatMap((cycle) => [...cycle.members, ...cycle.cycle]));
  const rows = await engine.query("MATCH (file:File) RETURN id(file) AS id, file.relativePath AS file") as Row[];
  const ids: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.id === "string" && typeof row.file === "string" && wanted.has(row.file)) ids[row.file] = row.id;
  }
  return ids;
}

// A path argument matches a file path or package name exactly, as a path
// suffix, or as a directory anywhere in it ("core/injector" matches
// "packages/core/injector/module.ts").
function matchesPath(member: string, path: string): boolean {
  const wanted = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!wanted) return true;
  return member === wanted || member.endsWith(`/${wanted}`) || member.startsWith(`${wanted}/`) || member.includes(`/${wanted}/`);
}

async function fileGraph(engine: IQueryEngine): Promise<Graph> {
  const graph: Graph = new Map();
  for (const edge of await loadImports(engine)) {
    if (!edge.target || edge.target === edge.file) continue;
    const existing = link(graph, edge.file, edge.target);
    existing.runtime ||= !edge.isTypeOnly;
  }
  return graph;
}

async function packageGraph(engine: IQueryEngine): Promise<Graph> {
  const rows = await engine.query(`
    MATCH (from:Package)-[rel:PACKAGE_IMPORTS_PACKAGE]->(to:Package)
    RETURN coalesce(from.name, from.relativePath) AS source, coalesce(to.name, to.relativePath) AS target,
      rel.dependencyType AS dependencyType
  `) as Row[];
  const graph: Graph = new Map();
  for (const row of rows) {
    const source = String(row.source);
    const target = String(row.target);
    if (source === target) continue;
    const edge = link(graph, source, target);
    edge.runtime = true;
    if (typeof row.dependencyType === "string") edge.types.add(row.dependencyType);
  }
  return graph;
}

function link(graph: Graph, from: string, to: string): Edge {
  let targets = graph.get(from);
  if (!targets) graph.set(from, targets = new Map());
  if (!graph.has(to)) graph.set(to, new Map());
  let edge = targets.get(to);
  if (!edge) targets.set(to, edge = { runtime: false, types: new Set() });
  return edge;
}

// Tarjan's algorithm without recursion. Returns the components with more than
// one member, each sorted, in no particular order.
export function stronglyConnected(graph: Graph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of [...graph.keys()].sort()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: Iterator<string> }> = [];
    const open = (node: string) => {
      index.set(node, counter);
      low.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
      work.push({ node, next: [...graph.get(node)!.keys()].sort()[Symbol.iterator]() });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const step = frame.next.next();
      if (!step.done) {
        const neighbour = step.value;
        if (!index.has(neighbour)) open(neighbour);
        else if (onStack.has(neighbour)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(neighbour)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        if (component.length > 1) components.push(component.sort());
      }
    }
  }
  return components;
}

// Shortest path from `start` back to itself inside one component, as a list
// of nodes ending with `start` again; runtime-only when asked.
function shortestCycle(graph: Graph, start: string, inside: Set<string>, runtimeOnly: boolean): string[] | null {
  const previous = new Map<string, string>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const [next, edge] of [...graph.get(node)!].sort(([a], [b]) => a.localeCompare(b))) {
      if (!inside.has(next) || (runtimeOnly && !edge.runtime)) continue;
      if (next === start) {
        const chain: string[] = [];
        for (let at = node; at !== start; at = previous.get(at)!) chain.push(at);
        return [start, ...chain.reverse(), start];
      }
      if (previous.has(next)) continue;
      previous.set(next, node);
      queue.push(next);
    }
  }
  return null;
}
