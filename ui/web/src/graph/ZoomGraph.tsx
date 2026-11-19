import Graph from "graphology";
import { useEffect, useRef } from "preact/hooks";
import { graphScene, type Scene, type SceneCluster, type SceneLeaf } from "../api.js";
import { seedLayout } from "../../../shared/seed-layout.js";
import { layoutClusters } from "./clusterLayout.js";
import type { LayoutRequest, LayoutResponse } from "./clusterLayout.worker.js";
import { categoryColor, categoryOfKind } from "./categories.js";
import { color } from "./colors.js";
import { FullCanvas, edgeAlpha, label, withAlpha } from "./FullGraph.js";
import { ZoomControls } from "./ZoomControls.js";

/** A folder opens when its disc is at least this share of the view, and closes again below the smaller one. */
const OPEN_SHARE = 0.32;
const CLOSE_SHARE = 0.12;
/** Most single nodes on screen; a folder that would go over it stays closed. */
const LEAF_BUDGET = 15000;
const LEAF_LIMIT = 1500;
const SETTLE_MS = 220;
/** Widest an edge may be drawn: edge sizes are in graph units, so deep in a folder the lines between top folders would grow without end. */
const MAX_EDGE_PX = 5;
const CLUSTER = "Folder";

type Disc = { x: number; y: number; r: number };
/** Where an open folder put its children: discs for subfolders, points for its own nodes, and the scale of its frame. */
type Frame = { discs: Map<string, Disc>; leaves: Map<string, { x: number; y: number }>; scale: number; leavesDisc: Disc | null };

const pathOf = (id: string) => id.slice(4);
const parentPath = (path: string) => (path.lastIndexOf("/") < 0 ? "" : path.slice(0, path.lastIndexOf("/")));

/**
 * The whole graph of a large project, a folder at a time. Far away every top
 * folder is one disc, sized by its nodes, with the relationships between folders
 * added up. Zooming into a disc opens it in place: its subfolders become discs and
 * its own nodes appear one by one; zooming back out closes it again. Positions are
 * kept while a folder stays open, so the picture never jumps.
 */
class ZoomCanvas extends FullCanvas {
  private open = new Set<string>();
  private scene: Scene | null = null;
  private items = new Map<string, SceneCluster | SceneLeaf>();
  private frames = new Map<string, Frame>();
  private bboxSet = false;
  private abort: AbortController | null = null;
  private settleTimer = 0;
  private generation = 0;
  private layoutWorker: Worker | null = null;
  private layoutJobs = new Map<number, { path: string; generation: number; ids: string[]; disc: Disc; natural: number }>();
  private nextJob = 0;
  private types: string[] = [];

  constructor(container: HTMLElement, overlay: HTMLElement, handlers: { onClick: (id: string) => void; onDoubleClick: (id: string) => void }, private onScene: (scene: Scene) => void) {
    super(container, overlay, handlers, {
      itemSizesReference: "positions",
      zoomToSizeRatioFunction: (ratio) => ratio,
      minCameraRatio: 0.00002,
      maxCameraRatio: 3,
      labelRenderedSizeThreshold: 7,
    });
    this.flyMinRatio = 0.00002;
    this.sigma.getCamera().on("updated", () => {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.settle(), SETTLE_MS);
    });
  }

  /** Start over with every folder closed (new data or other relationship kinds). */
  start(scene: Scene, types: string[]): void {
    this.generation += 1;
    this.types = types;
    this.open.clear();
    this.frames.clear();
    this.bboxSet = false;
    this.abort?.abort();
    this.show(scene);
    this.fit();
  }

  /** Zoom so that a folder fills a good part of the view; it then opens by itself. */
  zoomInto(id: string): void {
    const item = this.items.get(id);
    if (!item || item.type !== "cluster") { this.flyTo(id); return; }
    const disc = this.discOf(item);
    const at = this.sigma.getNodeDisplayData(id);
    if (!disc || !at) return;
    const { width, height } = this.sigma.getDimensions();
    const camera = this.sigma.getCamera();
    const now = this.screenRadius(disc);
    const ratio = camera.ratio * now / (0.45 * Math.min(width, height));
    camera.animate({ x: at.x, y: at.y, ratio }, { duration: 450, easing: "quadraticInOut" });
  }

  private screenRadius(disc: Disc): number {
    const a = this.sigma.graphToViewport({ x: disc.x, y: disc.y });
    const b = this.sigma.graphToViewport({ x: disc.x + disc.r, y: disc.y });
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  private onScreen(disc: Disc, radius: number): boolean {
    const { width, height } = this.sigma.getDimensions();
    const at = this.sigma.graphToViewport({ x: disc.x, y: disc.y });
    return at.x + radius > 0 && at.x - radius < width && at.y + radius > 0 && at.y - radius < height;
  }

  private discOf(item: SceneCluster): Disc | undefined {
    return this.frames.get(pathOf(item.parent))?.discs.get(item.id);
  }

  /** Cap the drawn width of the edges at the current zoom. */
  private fitEdges(): void {
    const perUnit = this.screenRadius({ x: 0, y: 0, r: 1 });
    if (!(perUnit > 0)) return;
    const cap = MAX_EDGE_PX / perUnit;
    let changed = false;
    this.graph.forEachEdge((_edge, attrs) => { if (Math.min(Number(attrs.base), cap) !== attrs.size) changed = true; });
    if (!changed) return;
    this.graph.updateEachEdgeAttributes((_edge, attrs) => { attrs.size = Math.min(Number(attrs.base), cap); return attrs; }, { attributes: ["size"] });
  }

  /** Once the camera rests: open the folders that fill the view, close those that shrank or left it. */
  private settle(): void {
    if (!this.scene) return;
    this.fitEdges();
    const { width, height } = this.sigma.getDimensions();
    const side = Math.min(width, height);
    const next = new Set(this.open);
    const isOpen = (path: string) => path === "" || next.has(path);
    for (const path of this.open) {
      const parent = this.frames.get(parentPath(path));
      const disc = parent?.discs.get(`dir:${path}`);
      if (!disc) { next.delete(path); continue; }
      const radius = this.screenRadius(disc);
      if (radius < CLOSE_SHARE * side || !this.onScreen(disc, radius)) for (const other of next) if (other === path || other.startsWith(`${path}/`)) next.delete(other);
    }
    let leaves = 0;
    for (const item of this.items.values()) if (item.type === "node" && isOpen(pathOf(item.parent))) leaves += 1;
    const candidates = [...this.items.values()]
      .filter((i): i is SceneCluster => i.type === "cluster" && isOpen(pathOf(i.parent)))
      .map((item) => { const disc = this.discOf(item); return { item, disc, radius: disc ? this.screenRadius(disc) : 0 }; })
      .filter((c) => c.disc && c.radius >= OPEN_SHARE * side && this.onScreen(c.disc, c.radius))
      .sort((a, b) => b.radius - a.radius);
    for (const { item } of candidates) {
      const adds = Math.min(item.direct, LEAF_LIMIT);
      if (leaves + adds > LEAF_BUDGET) continue;
      leaves += adds;
      next.add(item.path);
    }
    if (next.size === this.open.size && [...next].every((p) => this.open.has(p))) return;
    this.open = next;
    this.load();
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const generation = this.generation;
    try {
      const scene = await graphScene([...this.open], this.types, abort.signal);
      if (generation === this.generation && !abort.signal.aborted) this.show(scene);
    } catch (error) {
      if ((error as Error).name !== "AbortError") console.error(error);
    }
  }

  /** Lay out the folders opened since the last scene, then draw the scene as one new graph. */
  private show(scene: Scene): void {
    this.scene = scene;
    this.items = new Map(scene.items.map((i) => [i.id, i]));
    const children = new Map<string, Array<SceneCluster | SceneLeaf>>();
    for (const item of scene.items) (children.get(item.parent) ?? children.set(item.parent, []).get(item.parent)!).push(item);

    // Open folders from the top down: a folder's disc comes from its parent's frame.
    const openPaths = ["", ...[...this.open].sort((a, b) => a.split("/").length - b.split("/").length)];
    for (const path of openPaths) {
      if (this.frames.has(path)) continue;
      const disc = path === "" ? null : this.frames.get(parentPath(path))?.discs.get(`dir:${path}`);
      if (path !== "" && !disc) continue;
      this.frames.set(path, this.frame(path, children.get(`dir:${path}`) ?? [], disc ?? null, scene));
    }

    if (!this.bboxSet) {
      const root = this.frames.get("")!;
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (const d of root.discs.values()) { minX = Math.min(minX, d.x - d.r); maxX = Math.max(maxX, d.x + d.r); minY = Math.min(minY, d.y - d.r); maxY = Math.max(maxY, d.y + d.r); }
      for (const p of root.leaves.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      if (Number.isFinite(minX)) this.sigma.setCustomBBox({ x: [minX, maxX], y: [minY, maxY] });
      this.bboxSet = true;
    }

    const graph = new Graph({ multi: false, type: "directed" });
    const unit = new Map<string, number>();
    for (const item of scene.items) {
      const frame = this.frames.get(pathOf(item.parent));
      if (!frame) continue;
      if (item.type === "cluster") {
        const disc = frame.discs.get(item.id);
        if (!disc) continue;
        graph.addNode(item.id, {
          label: `${item.name === "(other)" ? "shared" : item.name}  ${item.nodes.toLocaleString("en-US")}`, size: disc.r * 0.9, x: disc.x, y: disc.y,
          color: withAlpha(color(item.label), 0.45), kind: CLUSTER, group: item.parent,
        });
        unit.set(item.id, disc.r * 0.01);
      } else {
        const at = frame.leaves.get(item.id);
        if (!at) continue;
        graph.addNode(item.id, {
          label: label(item.name), size: frame.scale * 0.8 * (1 + Math.min(6, 0.7 * Math.sqrt(item.degree))), x: at.x, y: at.y,
          color: color(item.label), kind: item.label, group: item.parent, hidden: this.hidden.has(item.label),
        });
        unit.set(item.id, frame.scale * 0.15);
      }
    }
    const alpha = edgeAlpha();
    for (const edge of scene.edges) {
      if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to) || graph.hasDirectedEdge(edge.from, edge.to)) continue;
      const solid = categoryColor(categoryOfKind(edge.kind).id);
      const size = Math.min(unit.get(edge.from)!, unit.get(edge.to)!) * (1 + Math.min(4, Math.log2(edge.count) / 2));
      graph.addDirectedEdge(edge.from, edge.to, { color: withAlpha(solid, edge.count > 1 ? Math.min(0.5, alpha * 2) : alpha), solid, size, base: size, kind: edge.kind, count: edge.count });
    }
    this.install(graph);
    this.fitEdges();
    this.buildClusterLabels();
    this.onScene(scene);
  }

  /**
   * Places the children of an open folder inside its disc: subfolders get discs
   * sized by their nodes, the folder's own nodes share one more disc. The force
   * layout of those nodes follows from the worker.
   */
  private frame(path: string, members: Array<SceneCluster | SceneLeaf>, disc: Disc | null, scene: Scene): Frame {
    const leaves = members.filter((m): m is SceneLeaf => m.type === "node");
    const clusters = members.filter((m): m is SceneCluster => m.type === "cluster");
    const leafGroup = `leaves:${path}`;
    const groups = clusters.map((c) => ({ name: c.id, count: c.nodes }));
    if (leaves.length > 0) groups.push({ name: leafGroup, count: leaves.length });
    const seeded = seedLayout(leaves.map((l) => ({ id: l.id, group: leafGroup, degree: l.degree })), groups);
    let reach = 0;
    for (const c of seeded.centers.values()) reach = Math.max(reach, Math.hypot(c.x, c.y) + c.radius);
    const scale = disc && reach > 0 ? (disc.r * 0.92) / reach : 1;
    const ox = disc?.x ?? 0; const oy = disc?.y ?? 0;
    const place = (p: { x: number; y: number }) => ({ x: ox + p.x * scale, y: oy + p.y * scale });
    const discs = new Map<string, Disc>();
    for (const c of clusters) { const at = seeded.centers.get(c.id)!; discs.set(c.id, { ...place(at), r: at.radius * scale }); }
    const frame: Frame = { discs, leaves: new Map(), scale, leavesDisc: null };
    for (const [id, at] of seeded.positions) frame.leaves.set(id, place(at));
    const center = seeded.centers.get(leafGroup);
    if (center && leaves.length > 2) {
      frame.leavesDisc = { ...place(center), r: center.radius * scale };
      this.layoutLeaves(path, leaves, frame.leavesDisc, scene);
    }
    return frame;
  }

  /** The force layout of an open folder's own nodes, in the worker; the result is fitted into their disc. */
  private layoutLeaves(path: string, leaves: SceneLeaf[], disc: Disc, scene: Scene): void {
    const ids = new Set(leaves.map((l) => l.id));
    const group = "g";
    const data: LayoutRequest["data"] = {
      nodes: leaves.map((l) => ({ id: l.id, label: l.label, name: l.name, group, degree: l.degree, file: l.file, line: l.line })),
      edges: scene.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
      groups: [{ name: group, count: leaves.length }],
    };
    // layoutClusters fits a lone group into the disc seedLayout gives it: centred at 0, this radius.
    const natural = 7.5 * Math.sqrt(leaves.length) + 8;
    const token = ++this.nextJob;
    this.layoutJobs.set(token, { path, generation: this.generation, ids: data.nodes.map((n) => n.id), disc, natural });
    try {
      if (!this.layoutWorker) {
        this.layoutWorker = new Worker(new URL("./clusterLayout.worker.ts", import.meta.url), { type: "module" });
        this.layoutWorker.onmessage = (event: MessageEvent<LayoutResponse>) => this.placeLeaves(event.data.token, event.data.positions);
      }
      this.layoutWorker.postMessage({ token, data } satisfies LayoutRequest);
    } catch {
      const placed = layoutClusters(data);
      const positions = new Float64Array(data.nodes.length * 2);
      data.nodes.forEach((n, i) => { const at = placed.get(n.id)!; positions[2 * i] = at.x; positions[2 * i + 1] = at.y; });
      queueMicrotask(() => this.placeLeaves(token, positions));
    }
  }

  private placeLeaves(token: number, positions: Float64Array): void {
    const job = this.layoutJobs.get(token);
    this.layoutJobs.delete(token);
    const frame = job && job.generation === this.generation ? this.frames.get(job.path) : undefined;
    if (!job || !frame) return;
    const scale = job.disc.r / job.natural;
    job.ids.forEach((id, i) => frame.leaves.set(id, { x: job.disc.x + positions[2 * i]! * scale, y: job.disc.y + positions[2 * i + 1]! * scale }));
    const moved = job.ids.filter((id) => this.graph.hasNode(id));
    if (moved.length === 0) return;
    this.indexPending = true;
    this.graph.updateEachNodeAttributes((id, attrs) => {
      const at = frame.leaves.get(id);
      if (at && attrs.group === `dir:${job.path}`) { attrs.x = at.x; attrs.y = at.y; }
      return attrs;
    }, { attributes: ["x", "y"] });
  }

  /** A name tag at the top of every open folder, shown while its disc is a fair size on screen. */
  protected override buildClusterLabels(): void {
    this.overlay.replaceChildren();
    this.clusters = [];
    for (const path of this.open) {
      const disc = this.frames.get(parentPath(path))?.discs.get(`dir:${path}`);
      if (!disc) continue;
      const el = document.createElement("div");
      el.className = "cluster-label";
      el.textContent = path === "(other)" ? "shared" : path;
      this.overlay.append(el);
      this.clusters.push({ name: path, x: disc.x, y: disc.y, el, shown: true, r: disc.r });
    }
    this.labelsAt = "";
    this.placeClusterLabels();
  }

  protected override placeClusterLabels(): void {
    const camera = this.sigma.getCamera().getState();
    const { width, height } = this.sigma.getDimensions();
    const key = `${camera.x},${camera.y},${camera.ratio},${camera.angle},${width},${height}`;
    if (key === this.labelsAt) return;
    this.labelsAt = key;
    for (const cluster of this.clusters) {
      // The tag sits on the top edge of the disc, kept inside the view while any of the disc is in it.
      const at = this.sigma.graphToViewport({ x: cluster.x, y: cluster.y });
      const radius = this.screenRadius({ x: cluster.x, y: cluster.y, r: cluster.r ?? 0 });
      const show = radius > 60 && radius < 6 * Math.max(width, height) && this.onScreen({ x: cluster.x, y: cluster.y, r: cluster.r ?? 0 }, radius);
      if (show !== cluster.shown) { cluster.el.style.display = show ? "" : "none"; cluster.shown = show; }
      if (show) cluster.el.style.transform = `translate(${Math.min(width - 80, Math.max(80, at.x))}px, ${Math.min(height - 14, Math.max(14, at.y - radius))}px) translate(-50%, -50%)`;
    }
  }

  override recolor(): void {
    super.recolor();
    if (this.scene) this.show(this.scene);
  }

  override destroy(): void {
    window.clearTimeout(this.settleTimer);
    this.abort?.abort();
    this.layoutWorker?.terminate();
    this.generation += 1;
    super.destroy();
  }
}

export function ZoomGraph(props: {
  scene: Scene;
  types: string[];
  hiddenKinds: Set<string>;
  selectedId?: string | null;
  flyToId?: string | null;
  onScene: (scene: Scene) => void;
  onClick: (id: string) => void;
  onDoubleClick: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const canvas = useRef<ZoomCanvas | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    if (!host.current || !overlay.current) return;
    const instance = new ZoomCanvas(host.current, overlay.current, {
      onClick: (id) => handlers.current.onClick(id),
      // Double-clicking a folder zooms into it; a node opens its focus view.
      onDoubleClick: (id) => (id.startsWith("dir:") ? instance.zoomInto(id) : handlers.current.onDoubleClick(id)),
    }, (scene) => handlers.current.onScene(scene));
    canvas.current = instance;
    const onTheme = () => instance.recolor();
    const onFit = () => instance.fit();
    window.addEventListener("concentrate:theme", onTheme);
    window.addEventListener("concentrate:fit", onFit);
    return () => { window.removeEventListener("concentrate:theme", onTheme); window.removeEventListener("concentrate:fit", onFit); instance.destroy(); canvas.current = null; };
  }, []);

  useEffect(() => { canvas.current?.start(props.scene, props.types); canvas.current?.setHidden(props.hiddenKinds); canvas.current?.select(props.selectedId ?? null); }, [props.scene]);
  useEffect(() => { canvas.current?.setHidden(props.hiddenKinds); }, [props.hiddenKinds]);
  useEffect(() => { canvas.current?.select(props.selectedId ?? null); }, [props.selectedId]);
  useEffect(() => { if (props.flyToId) canvas.current?.zoomInto(props.flyToId); }, [props.flyToId]);

  return (
    <div class="graph-surface" style={{ cursor: "default" }}>
      <div class="sigma-host" ref={host} />
      <div class="cluster-labels" ref={overlay} aria-hidden="true" />
      <ZoomControls onIn={() => canvas.current?.zoomIn()} onOut={() => canvas.current?.zoomOut()} onFit={() => canvas.current?.fit()} />
    </div>
  );
}
