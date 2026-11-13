import Graph from "graphology";
import Sigma from "sigma";
import { useEffect, useRef } from "preact/hooks";
import type { FullGraph as FullData } from "../api.js";
import { layoutClusters } from "./clusterLayout.js";
import { categoryColor, categoryOfKind, themeColor } from "./categories.js";
import { color } from "./colors.js";
import { ZoomControls } from "./ZoomControls.js";

/** `#rrggbb` as an `rgba()` string: Sigma's WebGL edges take their alpha from the colour. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return hex;
  const n = parseInt(value, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Edges are fainter on a dark page: light lines add up to white there. */
const edgeAlpha = () => {
  const theme = document.documentElement.dataset.theme;
  return (theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)) ? 0.09 : 0.16;
};

/** A file is labelled by its file name, anything else by its name. */
const label = (name: string) => { const tail = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name; return tail.length > 36 ? `${tail.slice(0, 35)}…` : tail; };

/**
 * The whole graph in one picture. Folders are clusters (seeded apart, then a short
 * force layout pulls related nodes together), colour is the kind of node, size is
 * the number of links. Far away you read cluster names and the hubs; closer, every
 * node gets its label. Hovering a node dims everything but its neighbours.
 */
class FullCanvas {
  readonly graph = new Graph({ multi: false, type: "directed" });
  private sigma: Sigma;
  private hovered: string | null = null;
  private selected: string | null = null;
  private hidden = new Set<string>();
  private clusters: Array<{ name: string; x: number; y: number; el: HTMLElement }> = [];

  constructor(private container: HTMLElement, private overlay: HTMLElement, handlers: { onClick: (id: string) => void; onDoubleClick: (id: string) => void }) {
    this.sigma = new Sigma(this.graph, container, {
      renderEdgeLabels: false,
      defaultEdgeType: "line",
      labelRenderedSizeThreshold: 9,
      labelDensity: 0.35,
      labelGridCellSize: 150,
      labelSize: 12,
      labelColor: { color: themeColor("--fg", "#1a1613") },
      labelFont: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      zIndex: true,
      minCameraRatio: 0.01,
      maxCameraRatio: 4,
      nodeReducer: (id, data) => {
        const attrs = { ...data };
        if (this.hidden.has(String(data.kind))) { attrs.hidden = true; return attrs; }
        if (id === this.selected) { attrs.highlighted = true; attrs.forceLabel = true; attrs.zIndex = 3; attrs.color = themeColor("--accent", "#a84d06"); }
        if (this.hovered) {
          if (id === this.hovered) { attrs.forceLabel = true; attrs.zIndex = 3; }
          else if (this.graph.areNeighbors(this.hovered, id)) { attrs.forceLabel = true; attrs.zIndex = 2; }
          else { attrs.color = themeColor("--bg-muted", "#eae3d6"); attrs.size = Number(attrs.size) * 0.6; attrs.label = ""; attrs.forceLabel = false; attrs.zIndex = 0; }
        }
        return attrs;
      },
      edgeReducer: (edge, data) => {
        const [a, b] = this.graph.extremities(edge);
        if (this.hidden.has(String(this.graph.getNodeAttribute(a, "kind"))) || this.hidden.has(String(this.graph.getNodeAttribute(b, "kind")))) return { ...data, hidden: true };
        const focus = this.hovered ?? this.selected;
        if (!focus) return data;
        return a === focus || b === focus ? { ...data, color: String(data.solid), size: 1.6, zIndex: 2 } : { ...data, hidden: this.hovered !== null };
      },
    });
    this.sigma.on("enterNode", ({ node }) => { this.hovered = node; this.sigma.refresh(); });
    this.sigma.on("leaveNode", () => { this.hovered = null; this.sigma.refresh(); });
    this.sigma.on("clickNode", ({ node }) => handlers.onClick(node));
    this.sigma.on("doubleClickNode", ({ node, preventSigmaDefault }) => { preventSigmaDefault(); handlers.onDoubleClick(node); });
    this.sigma.on("clickStage", () => handlers.onClick(""));
    this.sigma.on("afterRender", () => this.placeClusterLabels());
  }

  set(data: FullData): void {
    this.graph.clear();
    this.hovered = null;
    const positions = layoutClusters(data);
    for (const node of data.nodes) {
      const at = positions.get(node.id) ?? { x: 0, y: 0 };
      this.graph.addNode(node.id, {
        label: label(node.name), size: 1 + Math.min(6, 0.7 * Math.sqrt(node.degree)), color: color(node.label), kind: node.label,
        group: node.group, x: at.x, y: at.y,
      });
    }
    for (const edge of data.edges) {
      if (!this.graph.hasNode(edge.from) || !this.graph.hasNode(edge.to) || this.graph.hasDirectedEdge(edge.from, edge.to)) continue;
      const solid = categoryColor(categoryOfKind(edge.kind).id);
      this.graph.addDirectedEdge(edge.from, edge.to, { color: withAlpha(solid, edgeAlpha()), solid, size: 0.6, kind: edge.kind });
    }
    this.buildClusterLabels();
    this.fit();
  }

  setHidden(kinds: Set<string>): void { this.hidden = kinds; this.sigma.refresh(); }
  select(id: string | null): void { this.selected = id && this.graph.hasNode(id) ? id : null; this.sigma.refresh(); }
  fit(): void { this.sigma.getCamera().animatedReset({ duration: 250 }); }
  zoomIn(): void { this.sigma.getCamera().animatedZoom({ duration: 200 }); }
  zoomOut(): void { this.sigma.getCamera().animatedUnzoom({ duration: 200 }); }

  flyTo(id: string): void {
    const display = this.sigma.getNodeDisplayData(id);
    if (display) this.sigma.getCamera().animate({ x: display.x, y: display.y, ratio: 0.06 }, { duration: 450 });
  }

  recolor(): void {
    this.graph.forEachNode((id, attrs) => this.graph.setNodeAttribute(id, "color", color(String(attrs.kind))));
    this.graph.forEachEdge((edge, attrs) => {
      const solid = categoryColor(categoryOfKind(String(attrs.kind)).id);
      this.graph.mergeEdgeAttributes(edge, { solid, color: withAlpha(solid, edgeAlpha()) });
    });
    this.sigma.setSetting("labelColor", { color: themeColor("--fg", "#1a1613") });
    this.sigma.refresh();
  }

  /** One label per cluster, at the centre of its nodes; faded out as the camera gets close. */
  private buildClusterLabels(): void {
    this.overlay.replaceChildren();
    const sums = new Map<string, { x: number; y: number; n: number }>();
    this.graph.forEachNode((_id, attrs) => {
      const sum = sums.get(String(attrs.group)) ?? sums.set(String(attrs.group), { x: 0, y: 0, n: 0 }).get(String(attrs.group))!;
      sum.x += Number(attrs.x); sum.y += Number(attrs.y); sum.n += 1;
    });
    this.clusters = [...sums].filter(([, s]) => s.n >= 3).map(([name, s]) => {
      const el = document.createElement("div");
      el.className = "cluster-label";
      el.textContent = name === "(other)" ? "shared" : name;
      el.title = `${s.n.toLocaleString("en-US")} nodes`;
      this.overlay.append(el);
      return { name, x: s.x / s.n, y: s.y / s.n, el };
    });
    this.placeClusterLabels();
  }

  private placeClusterLabels(): void {
    const ratio = this.sigma.getCamera().ratio;
    const opacity = Math.max(0, Math.min(1, (ratio - 0.12) / 0.3));
    for (const cluster of this.clusters) {
      const at = this.sigma.graphToViewport({ x: cluster.x, y: cluster.y });
      cluster.el.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
      cluster.el.style.opacity = String(opacity);
    }
  }

  destroy(): void {
    this.sigma.kill();
    this.overlay.replaceChildren();
  }
}

export function FullGraph(props: {
  data: FullData;
  hiddenKinds: Set<string>;
  selectedId?: string | null;
  flyToId?: string | null;
  onClick: (id: string) => void;
  onDoubleClick: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const canvas = useRef<FullCanvas | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    if (!host.current || !overlay.current) return;
    const instance = new FullCanvas(host.current, overlay.current, { onClick: (id) => handlers.current.onClick(id), onDoubleClick: (id) => handlers.current.onDoubleClick(id) });
    canvas.current = instance;
    const onTheme = () => instance.recolor();
    const onFit = () => instance.fit();
    window.addEventListener("concentrate:theme", onTheme);
    window.addEventListener("concentrate:fit", onFit);
    return () => { window.removeEventListener("concentrate:theme", onTheme); window.removeEventListener("concentrate:fit", onFit); instance.destroy(); canvas.current = null; };
  }, []);

  useEffect(() => { canvas.current?.set(props.data); canvas.current?.setHidden(props.hiddenKinds); canvas.current?.select(props.selectedId ?? null); }, [props.data]);
  useEffect(() => { canvas.current?.setHidden(props.hiddenKinds); }, [props.hiddenKinds]);
  useEffect(() => { canvas.current?.select(props.selectedId ?? null); }, [props.selectedId]);
  useEffect(() => { if (props.flyToId) canvas.current?.flyTo(props.flyToId); }, [props.flyToId]);

  return (
    <div class="graph-surface" style={{ cursor: "default" }}>
      <div class="sigma-host" ref={host} />
      <div class="cluster-labels" ref={overlay} aria-hidden="true" />
      <ZoomControls onIn={() => canvas.current?.zoomIn()} onOut={() => canvas.current?.zoomOut()} onFit={() => canvas.current?.fit()} />
    </div>
  );
}
