// Runs the per-folder force layout off the main thread: on a large graph it takes
// seconds, and the page stays responsive meanwhile (the seed layout is shown).
import type { FullGraph } from "../api.js";
import { layoutClusters } from "./clusterLayout.js";

export type LayoutRequest = { token: number; data: Pick<FullGraph, "nodes" | "edges" | "groups"> };
/** Positions as x, y pairs in the order of `data.nodes`. */
export type LayoutResponse = { token: number; positions: Float64Array };

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { token, data } = event.data;
  const placed = layoutClusters(data);
  const positions = new Float64Array(data.nodes.length * 2);
  data.nodes.forEach((node, i) => {
    const at = placed.get(node.id) ?? { x: 0, y: 0 };
    positions[2 * i] = at.x;
    positions[2 * i + 1] = at.y;
  });
  (self as unknown as { postMessage(message: LayoutResponse, transfer: Transferable[]): void }).postMessage({ token, positions }, [positions.buffer]);
};
