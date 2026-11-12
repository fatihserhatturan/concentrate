import FA2Layout from "graphology-layout-forceatlas2/worker";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Graph from "graphology";
import Sigma from "sigma";
import { useEffect, useRef } from "preact/hooks";
import { categoryColor, themeColor, type CategoryId } from "./categories.js";
import { ZoomControls } from "./ZoomControls.js";

export type SigmaNode = { id: string; label: string; name: string; size: number; noise?: boolean };
export type SigmaEdge = { from: string; to: string; category: CategoryId; weight: number };

const LABELED = 10;

function nodeColor(label: string): string {
  return label === "File" ? themeColor("--node-file", "#94a3b8") : themeColor("--node-dir", "#64748b");
}

/** The directory overview: a force layout, the only place one is used. Hover shows a node's neighbours. */
class OverviewCanvas {
  readonly graph = new Graph({ multi: false, type: "directed" });
  private sigma: Sigma;
  private layout?: FA2Layout;
  private timer?: number;
  private hovered: string | null = null;
  selected: string | null = null;

  constructor(container: HTMLElement, private handlers: { onClick: (id: string) => void; onDoubleClick: (id: string) => void }) {
    this.sigma = new Sigma(this.graph, container, {
      renderEdgeLabels: false,
      defaultEdgeType: "arrow",
      labelRenderedSizeThreshold: 9,
      labelDensity: 0.7,
      labelGridCellSize: 120,
      labelSize: 12,
      labelColor: { color: themeColor("--fg", "#1f2328") },
      labelFont: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      zIndex: true,
      nodeReducer: (id, data) => {
        const attrs = { ...data };
        if (id === this.selected) { attrs.highlighted = true; attrs.forceLabel = true; attrs.zIndex = 2; attrs.color = themeColor("--accent", "#0969da"); }
        if (this.hovered) {
          if (id === this.hovered) { attrs.forceLabel = true; attrs.zIndex = 2; }
          else if (this.graph.areNeighbors(this.hovered, id)) attrs.forceLabel = true;
          else { attrs.color = themeColor("--bg-muted", "#eaeef2"); attrs.label = ""; attrs.forceLabel = false; }
        }
        return attrs;
      },
      edgeReducer: (edge, data) => {
        if (!this.hovered) return data;
        const [a, b] = this.graph.extremities(edge);
        return a === this.hovered || b === this.hovered ? { ...data, size: data.size + 1 } : { ...data, hidden: true };
      },
    });
    this.sigma.on("enterNode", ({ node }) => { this.hovered = node; this.sigma.refresh(); });
    this.sigma.on("leaveNode", () => { this.hovered = null; this.sigma.refresh(); });
    this.sigma.on("clickNode", ({ node }) => handlers.onClick(node));
    this.sigma.on("doubleClickNode", ({ node, preventSigmaDefault }) => { preventSigmaDefault(); handlers.onDoubleClick(node); });
  }

  set(nodes: SigmaNode[], edges: SigmaEdge[]): void {
    this.stopLayout();
    this.graph.clear();
    this.hovered = null;
    const ranked = [...nodes].sort((a, b) => b.size - a.size).slice(0, LABELED).map((n) => n.id);
    const count = nodes.length || 1;
    nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / count;
      this.graph.addNode(node.id, {
        label: node.name.length > 34 ? `…${node.name.slice(-33)}` : node.name,
        size: node.size, color: nodeColor(node.label), kind: node.label, forceLabel: ranked.includes(node.id),
        x: Math.cos(angle) * 10 + Math.random() * 0.1, y: Math.sin(angle) * 10 + Math.random() * 0.1,
      });
    });
    for (const edge of edges) {
      if (!this.graph.hasNode(edge.from) || !this.graph.hasNode(edge.to) || this.graph.hasDirectedEdge(edge.from, edge.to)) continue;
      this.graph.addDirectedEdge(edge.from, edge.to, { color: categoryColor(edge.category), size: Math.min(4, 1 + Math.log2(1 + edge.weight) / 2), category: edge.category });
    }
    this.runLayout();
    this.fit();
  }

  recolor(): void {
    this.graph.forEachNode((id, attrs) => this.graph.setNodeAttribute(id, "color", nodeColor(String(attrs.kind))));
    this.graph.forEachEdge((edge, attrs) => this.graph.setEdgeAttribute(edge, "color", categoryColor(attrs.category as CategoryId)));
    this.sigma.setSetting("labelColor", { color: themeColor("--fg", "#1f2328") });
    this.sigma.refresh();
  }

  select(id: string | null): void { this.selected = id; this.sigma.refresh(); }
  fit(): void { this.sigma.getCamera().animatedReset({ duration: 250 }); }
  zoomIn(): void { this.sigma.getCamera().animatedZoom({ duration: 200 }); }
  zoomOut(): void { this.sigma.getCamera().animatedUnzoom({ duration: 200 }); }

  private runLayout(): void {
    if (this.graph.order < 2) return;
    const settings = forceAtlas2.inferSettings(this.graph);
    forceAtlas2.assign(this.graph, { iterations: this.graph.order < 400 ? 80 : 12, settings });
    if (this.graph.order < 150) return;
    this.layout = new FA2Layout(this.graph, { settings: { ...settings, slowDown: 5 } });
    this.layout.start();
    this.timer = window.setTimeout(() => { this.stopLayout(); this.fit(); }, Math.min(6000, 1000 + this.graph.order * 2));
  }

  private stopLayout(): void {
    window.clearTimeout(this.timer);
    this.layout?.kill();
    this.layout = undefined;
  }

  destroy(): void {
    this.stopLayout();
    this.sigma.kill();
  }
}

export function SigmaGraph(props: {
  nodes: SigmaNode[];
  edges: SigmaEdge[];
  selectedId?: string | null;
  onClick: (id: string) => void;
  onDoubleClick: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<OverviewCanvas | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    if (!host.current) return;
    const instance = new OverviewCanvas(host.current, { onClick: (id) => handlers.current.onClick(id), onDoubleClick: (id) => handlers.current.onDoubleClick(id) });
    canvas.current = instance;
    const onTheme = () => instance.recolor();
    const onFit = () => instance.fit();
    window.addEventListener("concentrate:theme", onTheme);
    window.addEventListener("concentrate:fit", onFit);
    return () => { window.removeEventListener("concentrate:theme", onTheme); window.removeEventListener("concentrate:fit", onFit); instance.destroy(); canvas.current = null; };
  }, []);

  useEffect(() => { canvas.current?.set(props.nodes, props.edges); canvas.current?.select(props.selectedId ?? null); }, [props.nodes, props.edges]);
  useEffect(() => { canvas.current?.select(props.selectedId ?? null); }, [props.selectedId]);

  return (
    <div class="graph-surface" style={{ cursor: "default" }}>
      <div class="sigma-host" ref={host} />
      <ZoomControls onIn={() => canvas.current?.zoomIn()} onOut={() => canvas.current?.zoomOut()} onFit={() => canvas.current?.fit()} />
    </div>
  );
}
