import { loadIndex, nodeName, type GraphIndex, type IndexEdge } from "./index.js";
import { viewNode, type ViewEdge, type ViewNode } from "./views.js";

export const DEFAULT_FOCUS_LIMIT = 40;
const MAX_FOCUS_LIMIT = 300;

export type FocusResult = {
  center: string;
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** Distinct neighbours one step away on each side, and how many of them are drawn. */
  incoming: { total: number; shown: number };
  outgoing: { total: number; shown: number };
};

const edgeKey = (e: IndexEdge) => `${e.from}\0${e.to}\0${e.type}`;
const toView = (e: IndexEdge): ViewEdge => ({ from: e.from, to: e.to, type: e.type, kind: e.kind });

/**
 * One node and what surrounds it: what uses it (walking incoming relationships) and what it uses
 * (outgoing), `depth` steps each way. Each step keeps the `limit` most connected neighbours, in a
 * fixed order, so the same request always gives the same graph.
 */
export async function focus(projectPath: string, id: string, kinds: Set<string> | undefined, depth: number, limit: number): Promise<FocusResult> {
  const index = await loadIndex(projectPath);
  if (!index.nodes.has(id)) throw new Error(`Unknown node: ${id}`);
  const steps = Math.max(1, Math.min(3, Math.floor(depth) || 1));
  const cap = Math.max(5, Math.min(MAX_FOCUS_LIMIT, Math.floor(limit) || DEFAULT_FOCUS_LIMIT));
  const allowed = (edge: IndexEdge) => !kinds || kinds.has(edge.kind);
  const degree = (node: string) => (index.out.get(node)?.length ?? 0) + (index.inn.get(node)?.length ?? 0);
  const name = (node: string) => nodeName(index.nodes.get(node)!);

  const included = new Set([id]);
  const edges = new Map<string, IndexEdge>();
  const totals = { in: 0, out: 0 };
  const shown = { in: 0, out: 0 };

  for (const direction of ["in", "out"] as const) {
    const adjacency = direction === "out" ? index.out : index.inn;
    const seen = new Set([id]);
    let frontier = [id];
    for (let level = 1; level <= steps; level++) {
      const candidates = new Map<string, IndexEdge[]>();
      for (const node of frontier) {
        for (const edge of adjacency.get(node) ?? []) {
          const other = direction === "out" ? edge.to : edge.from;
          if (!allowed(edge) || seen.has(other) || !index.nodes.has(other)) continue;
          (candidates.get(other) ?? candidates.set(other, []).get(other)!).push(edge);
        }
      }
      if (level === 1) totals[direction] = candidates.size;
      const ranked = [...candidates.keys()]
        .sort((a, b) => degree(b) - degree(a) || name(a).localeCompare(name(b)) || a.localeCompare(b))
        .slice(0, cap);
      if (level === 1) shown[direction] = ranked.length;
      for (const other of ranked) {
        seen.add(other);
        included.add(other);
        for (const edge of candidates.get(other)!) edges.set(edgeKey(edge), edge);
      }
      frontier = ranked;
    }
  }

  const ids = [...included].sort((a, b) => (a === id ? -1 : b === id ? 1 : a.localeCompare(b)));
  return {
    center: id,
    nodes: ids.map((node) => viewNode(index, index.nodes.get(node)!)),
    edges: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))).map(toView),
    incoming: { total: totals.in, shown: shown.in },
    outgoing: { total: totals.out, shown: shown.out },
  };
}

export type PathResult = { found: boolean; directed: boolean; nodes: ViewNode[]; edges: ViewEdge[] };

function shortest(index: GraphIndex, from: string, to: string, allowed: (e: IndexEdge) => boolean, undirected: boolean): IndexEdge[] | null {
  const parent = new Map<string, { node: string; edge: IndexEdge }>();
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length > 0 && !seen.has(to)) {
    const next: string[] = [];
    for (const node of frontier) {
      const neighbours: Array<[string, IndexEdge]> = [];
      for (const edge of index.out.get(node) ?? []) if (allowed(edge)) neighbours.push([edge.to, edge]);
      if (undirected) for (const edge of index.inn.get(node) ?? []) if (allowed(edge)) neighbours.push([edge.from, edge]);
      for (const [other, edge] of neighbours.sort((a, b) => a[0].localeCompare(b[0]))) {
        if (seen.has(other) || !index.nodes.has(other)) continue;
        seen.add(other);
        parent.set(other, { node, edge });
        next.push(other);
      }
    }
    frontier = next;
  }
  if (!seen.has(to)) return null;
  const path: IndexEdge[] = [];
  for (let at = to; at !== from; at = parent.get(at)!.node) path.unshift(parent.get(at)!.edge);
  return path;
}

/** The shortest chain of relationships from one node to another: followed in their direction if possible, else either way. */
export async function path(projectPath: string, from: string, to: string, kinds: Set<string> | undefined): Promise<PathResult> {
  const index = await loadIndex(projectPath);
  for (const id of [from, to]) if (!index.nodes.has(id)) throw new Error(`Unknown node: ${id}`);
  // Containment would connect everything through its file; it is only used when asked for.
  const allowed = (edge: IndexEdge) => (kinds ? kinds.has(edge.kind) : edge.kind !== "defines");
  const directed = shortest(index, from, to, allowed, false);
  const found = directed ?? shortest(index, from, to, allowed, true);
  if (!found) return { found: false, directed: false, nodes: [], edges: [] };
  const ids = new Set([from, to]);
  for (const edge of found) { ids.add(edge.from); ids.add(edge.to); }
  return {
    found: true,
    directed: directed !== null,
    nodes: [...ids].map((id) => viewNode(index, index.nodes.get(id)!)),
    edges: found.map(toView),
  };
}
