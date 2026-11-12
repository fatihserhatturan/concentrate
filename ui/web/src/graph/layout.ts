import * as dagreModule from "@dagrejs/dagre";

// dagre is a CommonJS package: Node exposes it as `default`, bundlers as the namespace itself.
const dagre = (dagreModule as unknown as { default?: typeof dagreModule }).default ?? dagreModule;
const { graphlib, layout } = dagre;

export type LayoutNode = { id: string; name: string; sub?: string | null };
export type LayoutEdge = { from: string; to: string };
export type Placed = { x: number; y: number; width: number; height: number };
export type Layout = {
  nodes: Map<string, Placed>;
  edges: Map<string, Array<{ x: number; y: number }>>;
  width: number;
  height: number;
};

export const NODE_HEIGHT = 40;
const CHAR = 6.4;

/** A node is as wide as its text, within limits. */
export function nodeWidth(name: string, sub?: string | null): number {
  const chars = Math.max(name.length, (sub?.length ?? 0) * 0.85);
  return Math.round(Math.min(320, Math.max(150, 44 + chars * CHAR)));
}

export const edgeId = (from: string, to: string) => `${from}\0${to}`;

/**
 * Left-to-right layered layout. Nodes and edges go in sorted, so the same graph always gets the
 * same picture; what a node uses is to its right, what uses it to its left.
 */
export function layeredLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Layout {
  const g = new graphlib.Graph({ multigraph: false });
  g.setGraph({ rankdir: "LR", nodesep: 12, ranksep: 120, marginx: 28, marginy: 44, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    g.setNode(node.id, { width: nodeWidth(node.name, node.sub), height: NODE_HEIGHT });
  }
  const seen = new Set<string>();
  for (const edge of [...edges].sort((a, b) => edgeId(a.from, a.to).localeCompare(edgeId(b.from, b.to)))) {
    if (edge.from === edge.to || !g.hasNode(edge.from) || !g.hasNode(edge.to) || seen.has(edgeId(edge.from, edge.to))) continue;
    seen.add(edgeId(edge.from, edge.to));
    g.setEdge(edge.from, edge.to);
  }
  layout(g);
  const placed = new Map<string, Placed>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    placed.set(id, { x: n.x, y: n.y, width: n.width, height: n.height });
  }
  const routes = new Map<string, Array<{ x: number; y: number }>>();
  for (const e of g.edges()) routes.set(edgeId(e.v, e.w), g.edge(e).points);
  const graph = g.graph();
  return { nodes: placed, edges: routes, width: graph.width ?? 0, height: graph.height ?? 0 };
}

/** A smooth path through the points dagre routed an edge along (horizontal tangents at every point). */
export function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return "";
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const mid = (a.x + b.x) / 2;
    d += ` C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`;
  }
  return d;
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * The node an arrow key moves to: left and right go to the nearest node in that direction (a node
 * straight across counts for more than one far above or below); up and down stay in the column.
 */
export function neighbour(nodes: Map<string, Placed>, from: string, direction: Direction): string | null {
  const a = nodes.get(from);
  if (!a) return null;
  let best: { id: string; cost: number } | null = null;
  for (const [id, b] of nodes) {
    if (id === from) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let cost: number | null = null;
    if (direction === "left" && dx < -8) cost = -dx + 2 * Math.abs(dy);
    else if (direction === "right" && dx > 8) cost = dx + 2 * Math.abs(dy);
    else if (direction === "up" && Math.abs(dx) <= 8 && dy < -1) cost = -dy;
    else if (direction === "down" && Math.abs(dx) <= 8 && dy > 1) cost = dy;
    if (cost !== null && (best === null || cost < best.cost || (cost === best.cost && id < best.id))) best = { id, cost };
  }
  return best?.id ?? null;
}
