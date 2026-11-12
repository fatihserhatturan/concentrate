import Graph from "graphology";
import Sigma from "sigma";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { color, EDGE_KIND_COLORS } from "./colors.js";

export const MAX_DRAWN_NODES = 5000;

export type CanvasNode = { id: string; label: string; name: string; size?: number };
export type CanvasEdge = { from: string; to: string; kind: string; weight?: number; highlight?: boolean };

/** Sigma over a graphology graph; layout runs in a worker and stops by itself. */
export class GraphCanvas {
  readonly graph = new Graph({ multi: false, type: "directed" });
  private sigma: Sigma;
  private layout?: FA2Layout;
  private stopTimer?: number;
  highlighted: string | null = null;
  onSelect: (id: string | null) => void = () => {};
  onExpand: (id: string) => void = () => {};

  constructor(container: HTMLElement) {
    const dark = getComputedStyle(document.body).backgroundColor !== "rgb(255, 255, 255)";
    this.sigma = new Sigma(this.graph, container, {
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 7,
      labelDensity: 0.6,
      labelGridCellSize: 120,
      labelColor: { color: dark ? "#e6edf3" : "#1b1f24" },
      defaultEdgeType: "arrow",
      nodeReducer: (id, data) => (this.highlighted && this.highlighted === id ? { ...data, highlighted: true, zIndex: 2, forceLabel: true } : data),
    });
    this.sigma.on("clickNode", ({ node }) => { this.highlighted = node; this.sigma.refresh(); this.onSelect(node); });
    this.sigma.on("doubleClickNode", ({ node, preventSigmaDefault }) => { preventSigmaDefault(); this.onExpand(node); });
    this.sigma.on("clickStage", () => { this.highlighted = null; this.sigma.refresh(); this.onSelect(null); });
  }

  /** Replaces the drawn graph. Returns false and draws nothing above the node cap. */
  set(nodes: CanvasNode[], edges: CanvasEdge[]): boolean {
    this.stopLayout();
    this.graph.clear();
    if (nodes.length > MAX_DRAWN_NODES) return false;
    this.add(nodes, edges, true);
    return true;
  }

  add(nodes: CanvasNode[], edges: CanvasEdge[], fresh = false): boolean {
    if (this.graph.order + nodes.length > MAX_DRAWN_NODES) return false;
    const n = nodes.length || 1;
    const near = fresh ? undefined : this.anchor();
    nodes.forEach((node, i) => {
      if (this.graph.hasNode(node.id)) return;
      const angle = (2 * Math.PI * i) / n;
      this.graph.addNode(node.id, {
        label: node.name.length > 40 ? `…${node.name.slice(-39)}` : node.name,
        size: node.size ?? 5,
        color: color(node.label),
        x: (near?.x ?? 0) + Math.cos(angle) * (fresh ? 10 : 1) + Math.random() * 0.1,
        y: (near?.y ?? 0) + Math.sin(angle) * (fresh ? 10 : 1) + Math.random() * 0.1,
        nodeLabel: node.label,
      });
    });
    for (const edge of edges) {
      if (!this.graph.hasNode(edge.from) || !this.graph.hasNode(edge.to) || this.graph.hasDirectedEdge(edge.from, edge.to)) continue;
      this.graph.addDirectedEdge(edge.from, edge.to, {
        color: edge.highlight ? "#cf222e" : EDGE_KIND_COLORS[edge.kind] ?? "#8c959f",
        size: edge.highlight ? 3 : Math.min(4, 1 + Math.log2(1 + (edge.weight ?? 1)) / 2),
        kind: edge.kind,
      });
    }
    this.runLayout();
    return true;
  }

  setHiddenKinds(hidden: Set<string>): void {
    this.graph.forEachEdge((edge, attrs) => this.graph.setEdgeAttribute(edge, "hidden", hidden.has(attrs.kind)));
  }

  setTheme(dark: boolean): void {
    this.sigma.setSetting("labelColor", { color: dark ? "#e6edf3" : "#1b1f24" });
    this.sigma.refresh();
  }

  focus(id: string): void {
    if (!this.graph.hasNode(id)) return;
    this.highlighted = id;
    const { x, y } = this.sigma.getNodeDisplayData(id) ?? { x: 0.5, y: 0.5 };
    this.sigma.getCamera().animate({ x, y, ratio: 0.3 }, { duration: 400 });
    this.sigma.refresh();
  }

  private anchor(): { x: number; y: number } | undefined {
    return this.highlighted && this.graph.hasNode(this.highlighted)
      ? { x: this.graph.getNodeAttribute(this.highlighted, "x"), y: this.graph.getNodeAttribute(this.highlighted, "y") }
      : undefined;
  }

  private runLayout(): void {
    this.stopLayout();
    if (this.graph.order < 2) return;
    // Settle small graphs on the spot so they do not jump around.
    forceAtlas2.assign(this.graph, { iterations: this.graph.order < 400 ? 60 : 10, settings: forceAtlas2.inferSettings(this.graph) });
    if (this.graph.order < 150) return;
    this.layout = new FA2Layout(this.graph, { settings: { ...forceAtlas2.inferSettings(this.graph), slowDown: 5 } });
    this.layout.start();
    this.stopTimer = window.setTimeout(() => this.stopLayout(), Math.min(6000, 1000 + this.graph.order * 2));
  }

  private stopLayout(): void {
    window.clearTimeout(this.stopTimer);
    this.layout?.kill();
    this.layout = undefined;
  }

  destroy(): void {
    this.stopLayout();
    this.sigma.kill();
  }
}
