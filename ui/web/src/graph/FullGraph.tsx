import Graph from "graphology";
import Sigma from "sigma";
import type { Settings } from "sigma/settings";
import { useEffect, useRef } from "preact/hooks";
import type { FullGraph as FullData } from "../api.js";
import { layoutClusters } from "./clusterLayout.js";
import type { LayoutRequest, LayoutResponse } from "./clusterLayout.worker.js";
import { seedLayout } from "../../../shared/seed-layout.js";
import { categoryColor, categoryOfKind, themeColor } from "./categories.js";
import { color } from "./colors.js";
import { ZoomControls } from "./ZoomControls.js";

/** `#rrggbb` as an `rgba()` string: Sigma's WebGL edges take their alpha from the colour. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return hex;
  const n = parseInt(value, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Edges are fainter on a dark page: light lines add up to white there. */
export const edgeAlpha = () => {
  const theme = document.documentElement.dataset.theme;
  return (theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)) ? 0.09 : 0.16;
};

/** A file is labelled by its file name, anything else by its name. */
export const label = (name: string) => { const tail = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name; return tail.length > 36 ? `${tail.slice(0, 35)}…` : tail; };

/** Camera ratios for flying to a node: never closer than MIN, and a neighbourhood wider than MAX is not framed whole. */
const FLY_MIN_RATIO = 0.02;
const FLY_MAX_RATIO = 0.3;
/** How long the camera must be still before a hover repaints the graph. */
const SETTLE_MS = 120;

/**
 * The whole graph in one picture. Folders are clusters (seeded apart, then a short
 * force layout pulls related nodes together), colour is the kind of node, size is
 * the number of links. Far away you read cluster names and the hubs; closer, every
 * node gets its label. Hovering a node dims everything but its neighbours.
 *
 * Kept smooth on large graphs: a hover repaints without re-indexing (positions and
 * sizes never change on hover) and only once the camera is still, the reducers
 * return the data untouched when nothing is hovered or selected, and the force
 * layout runs in a worker. Edges stay drawn while moving: sigma's `hideEdgesOnMove`
 * re-indexes the whole graph when a drag ends, which costs more than drawing them.
 */
export class FullCanvas {
  protected graph = new Graph({ multi: false, type: "directed" });
  protected sigma: Sigma;
  /** The hover the user asked for, and the one painted: they differ until the camera settles. */
  private wantedHover: string | null = null;
  private hovered: string | null = null;
  private neighbors = new Set<string>();
  protected selected: string | null = null;
  protected hidden = new Set<string>();
  /** Cluster name tags; `r` is the radius of the disc a tag belongs to, where there is one. */
  protected clusters: Array<{ name: string; x: number; y: number; el: HTMLElement; shown: boolean; r?: number }> = [];
  protected labelsAt = "";
  private hoverFrame = 0;
  private hoverTimer = 0;
  private worker: Worker | null = null;
  private layoutToken = 0;
  /** True from a change that needs sigma to index the graph again until the next frame has done it. */
  protected indexPending = true;
  /** The closest a flight to a node may get. */
  protected flyMinRatio = FLY_MIN_RATIO;

  constructor(protected container: HTMLElement, protected overlay: HTMLElement, handlers: { onClick: (id: string) => void; onDoubleClick: (id: string) => void }, settings: Partial<Settings> = {}) {
    this.sigma = new Sigma(this.graph, container, {
      renderEdgeLabels: false,
      defaultEdgeType: "line",
      labelRenderedSizeThreshold: 9,
      labelDensity: 0.35,
      labelGridCellSize: 150,
      labelSize: 12,
      labelColor: { color: themeColor("--fg", "#1a1613") },
      labelFont: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      minCameraRatio: 0.01,
      maxCameraRatio: 4,
      ...settings,
      nodeReducer: (id, data) => {
        if (!this.hovered && !this.selected) return data;
        const attrs = { ...data };
        if (id === this.selected) { attrs.highlighted = true; attrs.forceLabel = true; attrs.color = themeColor("--accent", "#a84d06"); }
        if (this.hovered) {
          if (id === this.hovered || this.neighbors.has(id)) attrs.forceLabel = true;
          else if (id !== this.selected) { attrs.color = this.dimColor; attrs.label = ""; attrs.forceLabel = false; }
        }
        return attrs;
      },
      edgeReducer: (edge, data) => {
        const focus = this.hovered ?? this.selected;
        if (!focus) return data;
        const [a, b] = this.graph.extremities(edge);
        return a === focus || b === focus ? { ...data, color: String(data.solid), size: Number(data.size) * 2.6 } : this.hovered ? { ...data, hidden: true } : data;
      },
    });
    this.sigma.on("enterNode", ({ node }) => this.hover(node));
    this.sigma.on("leaveNode", () => this.hover(null));
    this.sigma.on("clickNode", ({ node }) => handlers.onClick(node));
    this.sigma.on("doubleClickNode", ({ node, preventSigmaDefault }) => { preventSigmaDefault(); handlers.onDoubleClick(node); });
    this.sigma.on("clickStage", () => handlers.onClick(""));
    this.sigma.on("afterRender", () => { this.indexPending = false; this.placeClusterLabels(); });
  }

  protected dimColor = themeColor("--bg-muted", "#eae3d6");

  set(data: FullData): void {
    const graph = new Graph({ multi: false, type: "directed" });
    const { positions } = seedLayout(data.nodes, data.groups);
    for (const node of data.nodes) {
      const at = positions.get(node.id) ?? { x: 0, y: 0 };
      graph.addNode(node.id, {
        label: label(node.name), size: 1 + Math.min(6, 0.7 * Math.sqrt(node.degree)), color: color(node.label), kind: node.label,
        group: node.group, x: at.x, y: at.y, hidden: this.hidden.has(node.label),
      });
    }
    const alpha = edgeAlpha();
    for (const edge of data.edges) {
      if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to) || graph.hasDirectedEdge(edge.from, edge.to)) continue;
      const solid = categoryColor(categoryOfKind(edge.kind).id);
      graph.addDirectedEdge(edge.from, edge.to, { color: withAlpha(solid, alpha), solid, size: 0.6, kind: edge.kind });
    }
    this.install(graph);
    this.buildClusterLabels();
    this.fit();
    this.layout(data);
  }

  /** Show a new graph: sigma then indexes it once, not once per added node. */
  protected install(graph: Graph): void {
    this.hovered = this.wantedHover = null;
    this.neighbors.clear();
    if (this.selected && !graph.hasNode(this.selected)) this.selected = null;
    this.graph = graph;
    this.indexPending = true;
    this.sigma.setGraph(graph);
  }

  /** The force layout, in a worker; the seed positions stay until it is done. Without workers it runs here. */
  private layout(data: FullData): void {
    const token = ++this.layoutToken;
    const apply = (positions: Float64Array) => {
      if (token !== this.layoutToken) return;
      this.indexPending = true;
      const index = new Map(data.nodes.map((n, i) => [n.id, i]));
      this.graph.updateEachNodeAttributes((id, attrs) => {
        const i = index.get(id);
        if (i === undefined) return attrs;
        attrs.x = positions[2 * i]!; attrs.y = positions[2 * i + 1]!;
        return attrs;
      }, { attributes: ["x", "y"] });
      this.buildClusterLabels();
    };
    const request: LayoutRequest = { token, data: { nodes: data.nodes, edges: data.edges, groups: data.groups } };
    try {
      this.worker ??= new Worker(new URL("./clusterLayout.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<LayoutResponse>) => apply(event.data.positions);
      this.worker.onerror = () => { this.worker?.terminate(); this.worker = null; apply(this.layoutHere(data)); };
      this.worker.postMessage(request);
    } catch {
      apply(this.layoutHere(data));
    }
  }

  private layoutHere(data: FullData): Float64Array {
    const placed = layoutClusters(data);
    const positions = new Float64Array(data.nodes.length * 2);
    data.nodes.forEach((n, i) => { const at = placed.get(n.id) ?? { x: 0, y: 0 }; positions[2 * i] = at.x; positions[2 * i + 1] = at.y; });
    return positions;
  }

  /** Kinds of node to hide: written into the graph once, so the reducers need not look at every item on every frame. */
  setHidden(kinds: Set<string>): void {
    this.hidden = kinds;
    this.indexPending = true;
    this.graph.updateEachNodeAttributes((_id, attrs) => { attrs.hidden = kinds.has(String(attrs.kind)); return attrs; }, { attributes: ["hidden"] });
  }

  select(id: string | null): void {
    this.selected = id && this.graph.hasNode(id) ? id : null;
    this.repaint();
  }

  fit(): void { this.sigma.getCamera().animatedReset({ duration: 250 }); }
  zoomIn(): void { this.sigma.getCamera().animatedZoom({ duration: 200 }); }
  zoomOut(): void { this.sigma.getCamera().animatedUnzoom({ duration: 200 }); }

  /**
   * Centre on a node and frame it with its neighbours. Neighbours in far-away
   * folders would zoom the picture right out, so then only the ones in its own
   * folder are framed, and failing that the node alone.
   */
  flyTo(id: string): void {
    const at = this.sigma.getNodeDisplayData(id);
    if (!at) return;
    const group = this.graph.getNodeAttribute(id, "group");
    const frame = (ids: string[]) => {
      let minX = at.x; let maxX = at.x; let minY = at.y; let maxY = at.y;
      for (const other of ids) {
        const d = this.sigma.getNodeDisplayData(other);
        if (!d || d.hidden) continue;
        minX = Math.min(minX, d.x); maxX = Math.max(maxX, d.x); minY = Math.min(minY, d.y); maxY = Math.max(maxY, d.y);
      }
      return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio: Math.max(this.flyMinRatio, Math.max(maxX - minX, maxY - minY) * 1.4) };
    };
    const neighbors = this.graph.neighbors(id);
    let target = frame(neighbors);
    if (target.ratio > FLY_MAX_RATIO) target = frame(neighbors.filter((n) => this.graph.getNodeAttribute(n, "group") === group));
    if (target.ratio > FLY_MAX_RATIO) target = { x: at.x, y: at.y, ratio: Math.min(0.06, this.sigma.getCamera().ratio) };
    this.sigma.getCamera().animate(target, { duration: 450, easing: "quadraticInOut" });
  }

  recolor(): void {
    this.dimColor = themeColor("--bg-muted", "#eae3d6");
    this.graph.updateEachNodeAttributes((_id, attrs) => { attrs.color = color(String(attrs.kind)); return attrs; }, { attributes: ["color"] });
    const alpha = edgeAlpha();
    this.graph.updateEachEdgeAttributes((_edge, attrs) => {
      const solid = categoryColor(categoryOfKind(String(attrs.kind)).id);
      attrs.solid = solid; attrs.color = withAlpha(solid, alpha);
      return attrs;
    }, { attributes: ["solid", "color"] });
    this.sigma.setSetting("labelColor", { color: themeColor("--fg", "#1a1613") });
  }

  private get moving(): boolean {
    return this.sigma.getCamera().isAnimated() || this.sigma.getMouseCaptor().isMoving;
  }

  /** Hover changes come in bursts while the pointer crosses nodes: paint the last one, once per frame, with the camera still. */
  private hover(node: string | null): void {
    this.wantedHover = node;
    if (this.hoverFrame || this.hoverTimer) return;
    this.hoverFrame = requestAnimationFrame(() => this.applyHover());
  }

  private applyHover(): void {
    this.hoverFrame = 0;
    if (this.moving) { this.hoverTimer = window.setTimeout(() => { this.hoverTimer = 0; this.applyHover(); }, SETTLE_MS); return; }
    if (this.wantedHover === this.hovered) return;
    this.hovered = this.wantedHover && this.graph.hasNode(this.wantedHover) ? this.wantedHover : null;
    this.neighbors = new Set(this.hovered ? this.graph.neighbors(this.hovered) : []);
    this.repaint();
  }

  /** Re-run the reducers without re-indexing: only colours, labels and edge visibility change. */
  protected repaint(): void {
    // A partial repaint needs the items to be indexed already; right after a new graph they are not yet.
    if (this.indexPending) { this.sigma.scheduleRefresh(); return; }
    this.sigma.refresh({ partialGraph: { nodes: this.graph.nodes(), edges: this.graph.edges() }, skipIndexation: true });
  }

  /** One label per cluster, at the centre of its nodes; faded out as the camera gets close. */
  protected buildClusterLabels(): void {
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
      return { name, x: s.x / s.n, y: s.y / s.n, el, shown: true };
    });
    this.labelsAt = "";
    this.placeClusterLabels();
  }

  /** Runs after every frame, so it only touches the DOM when the camera or the size changed, and skips labels out of view. */
  protected placeClusterLabels(): void {
    const camera = this.sigma.getCamera().getState();
    const { width, height } = this.sigma.getDimensions();
    const key = `${camera.x},${camera.y},${camera.ratio},${camera.angle},${width},${height}`;
    if (key === this.labelsAt) return;
    this.labelsAt = key;
    const opacity = Math.max(0, Math.min(1, (camera.ratio - 0.12) / 0.3));
    for (const cluster of this.clusters) {
      const at = opacity > 0 ? this.sigma.graphToViewport({ x: cluster.x, y: cluster.y }) : null;
      const show = at !== null && at.x > -200 && at.x < width + 200 && at.y > -50 && at.y < height + 50;
      if (show !== cluster.shown) { cluster.el.style.display = show ? "" : "none"; cluster.shown = show; }
      if (!show) continue;
      cluster.el.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
      cluster.el.style.opacity = String(opacity);
    }
  }

  destroy(): void {
    this.layoutToken += 1;
    cancelAnimationFrame(this.hoverFrame);
    window.clearTimeout(this.hoverTimer);
    this.worker?.terminate();
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
