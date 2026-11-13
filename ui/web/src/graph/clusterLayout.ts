import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { FullGraph } from "../api.js";
import { seedLayout } from "../../../shared/seed-layout.js";

/**
 * Positions for the whole-graph view. A single force layout over everything melts
 * the folders into one blob, so each folder is laid out on its own (only its own
 * relationships pull) and then scaled into the disc `seedLayout` reserved for it.
 * Links between folders are simply drawn across the gaps.
 */
export function layoutClusters(data: FullGraph): Map<string, { x: number; y: number }> {
  const { positions: seeds, centers } = seedLayout(data.nodes, data.groups);
  const groupOf = new Map(data.nodes.map((n) => [n.id, n.group]));
  const members = new Map<string, string[]>();
  for (const node of data.nodes) (members.get(node.group) ?? members.set(node.group, []).get(node.group)!).push(node.id);
  const inside = new Map<string, Array<[string, string]>>();
  for (const edge of data.edges) {
    const group = groupOf.get(edge.from);
    if (group !== undefined && group === groupOf.get(edge.to)) (inside.get(group) ?? inside.set(group, []).get(group)!).push([edge.from, edge.to]);
  }

  const result = new Map<string, { x: number; y: number }>();
  for (const [group, ids] of members) {
    const center = centers.get(group)!;
    const sub = new Graph({ type: "undirected", multi: false });
    for (const id of ids) sub.addNode(id, { x: seeds.get(id)!.x - center.x, y: seeds.get(id)!.y - center.y });
    for (const [a, b] of inside.get(group) ?? []) if (a !== b && !sub.hasEdge(a, b)) sub.addUndirectedEdge(a, b);

    if (sub.order > 2 && sub.size > 0) {
      const settings = { ...forceAtlas2.inferSettings(sub), barnesHutOptimize: sub.order > 300, gravity: 1.2, scalingRatio: 6, slowDown: 4, linLogMode: true };
      forceAtlas2.assign(sub, { iterations: sub.order <= 500 ? 200 : sub.order <= 3000 ? 80 : 30, settings });
    }

    // Scale the result into the reserved disc.
    let cx = 0; let cy = 0;
    sub.forEachNode((_id, a) => { cx += Number(a.x); cy += Number(a.y); });
    cx /= sub.order; cy /= sub.order;
    let reach = 0;
    sub.forEachNode((_id, a) => { reach = Math.max(reach, Math.hypot(Number(a.x) - cx, Number(a.y) - cy)); });
    const scale = reach > 0 ? (center.radius * 0.96) / reach : 1;
    sub.forEachNode((id, a) => result.set(id, { x: center.x + (Number(a.x) - cx) * scale, y: center.y + (Number(a.y) - cy) * scale }));
  }
  return result;
}
