import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ViewEdge, ViewNode } from "../api.js";
import { KindGlyphSvg } from "../components/KindGlyph.js";
import { CATEGORIES, categoryOfKind, type CategoryId } from "./categories.js";
import { edgeId, layeredLayout, neighbour, NODE_HEIGHT, smoothPath, nodeWidth, type Direction } from "./layout.js";
import { ZoomControls } from "./ZoomControls.js";
import { useViewport } from "./useViewport.js";

const CHAR = 6.4;
const STUB_IN = "\u0000stub-in";
const STUB_OUT = "\u0000stub-out";

const clip = (text: string, width: number) => {
  const max = Math.max(6, Math.floor((width - 44) / CHAR));
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
};

/** The file name and its folder, the part that tells two nodes with one name apart. */
const subtitle = (node: ViewNode) => (node.file ? `${node.file}${node.line ? `:${node.line}` : ""}` : null);

export type Stub = { more: number; onMore: () => void };

export function LayeredGraph(props: {
  nodes: ViewNode[];
  edges: Array<ViewEdge & { highlight?: boolean }>;
  centerId?: string | null;
  /** Nodes and edges to emphasise (a traced path); everything else is dimmed. */
  pathIds?: Set<string>;
  /** Left and right column titles of a focus view. */
  headers?: { left: string; right: string };
  stubs?: { in?: Stub; out?: Stub };
  /** Changes when the data changes, so the picture is fitted again. */
  fitKey: string;
  /** Clicking a node; `trace` is true with Shift held or while a path target is being picked. */
  onActivate: (id: string, options: { trace: boolean }) => void;
  tracing?: boolean;
}) {
  const { nodes, edges, centerId } = props;
  const { ref, view, setView, fit, zoomIn, zoomOut, handlers, dragged } = useViewport();
  const elements = useRef(new Map<string, SVGGElement>());
  const [hovered, setHovered] = useState<string | null>(null);

  const layout = useMemo(() => {
    const items = nodes.map((n) => ({ id: n.id, name: n.name, sub: subtitle(n) }));
    const links = edges.map((e) => ({ from: e.from, to: e.to }));
    if (props.stubs?.in && centerId) { items.push({ id: STUB_IN, name: `+${props.stubs.in.more} more`, sub: null }); links.push({ from: STUB_IN, to: centerId }); }
    if (props.stubs?.out && centerId) { items.push({ id: STUB_OUT, name: `+${props.stubs.out.more} more`, sub: null }); links.push({ from: centerId, to: STUB_OUT }); }
    return layeredLayout(items, links);
  }, [nodes, edges, centerId, props.stubs?.in?.more, props.stubs?.out?.more]);

  useEffect(() => { fit(layout.width, layout.height); }, [props.fitKey, layout]);
  useEffect(() => {
    const onFit = () => fit(layout.width, layout.height);
    window.addEventListener("concentrate:fit", onFit);
    return () => window.removeEventListener("concentrate:fit", onFit);
  }, [layout]);

  // One line per pair of nodes; its category is the first one among the relationships between them.
  const pairs = useMemo(() => {
    const map = new Map<string, { from: string; to: string; category: CategoryId; types: string[]; highlight: boolean }>();
    for (const e of edges) {
      const key = edgeId(e.from, e.to);
      const category = categoryOfKind(e.kind).id;
      const entry = map.get(key);
      if (!entry) map.set(key, { from: e.from, to: e.to, category, types: [e.type], highlight: e.highlight === true });
      else {
        entry.types.push(e.type);
        if (CATEGORIES.findIndex((c) => c.id === category) < CATEGORIES.findIndex((c) => c.id === entry.category)) entry.category = category;
      }
    }
    for (const stub of [props.stubs?.in && centerId ? { from: STUB_IN, to: centerId } : null, props.stubs?.out && centerId ? { from: centerId!, to: STUB_OUT } : null]) {
      if (stub) map.set(edgeId(stub.from, stub.to), { ...stub, category: "structure", types: [], highlight: false });
    }
    return [...map.values()];
  }, [edges, centerId, props.stubs?.in, props.stubs?.out]);

  const neighbours = useMemo(() => {
    if (!hovered) return null;
    const set = new Set([hovered]);
    for (const p of pairs) { if (p.from === hovered) set.add(p.to); if (p.to === hovered) set.add(p.from); }
    return set;
  }, [hovered, pairs]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const center = centerId ? layout.nodes.get(centerId) : undefined;

  // Column titles over the leftmost and rightmost columns.
  const headerAt = (side: "left" | "right") => {
    if (!center) return null;
    const placed = [...layout.nodes.values()].filter((n) => (side === "left" ? n.x < center.x - 1 : n.x > center.x + 1));
    if (placed.length === 0) return null;
    return side === "left" ? Math.min(...placed.map((n) => n.x - n.width / 2)) : Math.max(...placed.map((n) => n.x - n.width / 2));
  };
  const leftX = props.headers ? headerAt("left") : null;
  const rightX = props.headers ? headerAt("right") : null;
  const headerY = 24;

  const activate = (id: string, event: MouseEvent | KeyboardEvent) => {
    if (dragged.current) return;
    props.onActivate(id, { trace: props.tracing === true || event.shiftKey });
  };

  // Arrow keys move the keyboard focus to the nearest node in that direction; Enter on it refocuses the graph.
  const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  const onKeyDown = (event: KeyboardEvent) => {
    const direction = ARROWS[event.key];
    if (!direction || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const fromId = [...elements.current].find(([, el]) => el === (event.target as Element).closest("g.node"))?.[0] ?? (centerId && layout.nodes.has(centerId) ? centerId : [...layout.nodes.keys()][0]);
    if (!fromId) return;
    const next = neighbour(layout.nodes, fromId, direction) ?? fromId;
    elements.current.get(next)?.focus({ preventScroll: true });
    // keep the node in view
    const box = ref.current?.getBoundingClientRect();
    const placed = layout.nodes.get(next);
    if (box && placed) {
      const sx = placed.x * view.k + view.x;
      const sy = placed.y * view.k + view.y;
      if (sx < 60 || sx > box.width - 60 || sy < 40 || sy > box.height - 40) setView((v) => ({ ...v, x: box.width / 2 - placed.x * v.k, y: box.height / 2 - placed.y * v.k }));
    }
  };
  const track = (id: string) => (el: SVGGElement | null) => { if (el) elements.current.set(id, el); else elements.current.delete(id); };

  return (
    <div class="graph-surface" ref={ref} {...handlers} onKeyDown={onKeyDown} role="application" aria-label="Graph. Drag to pan, scroll to zoom, arrow keys move between nodes, Enter refocuses.">
      <svg class="layered" width="100%" height="100%">
        <defs>
          {CATEGORIES.map((c) => (
            <marker id={`arrow-${c.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 Z" style={{ fill: `var(--cat-${c.id})` }} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {props.headers && leftX !== null && <text class="col-title" x={leftX} y={headerY}>{props.headers.left}</text>}
          {props.headers && rightX !== null && <text class="col-title" x={rightX} y={headerY}>{props.headers.right}</text>}
          <g class="edges">
            {pairs.map((p) => {
              const points = layout.edges.get(edgeId(p.from, p.to));
              if (!points) return null;
              const emphasised = props.pathIds ? props.pathIds.has(p.from) && props.pathIds.has(p.to) : false;
              const dim = (neighbours && !(p.from === hovered || p.to === hovered)) || (props.pathIds && !emphasised);
              const cat = CATEGORIES.find((c) => c.id === p.category)!;
              return (
                <path
                  class={`edge${dim ? " dim" : ""}${emphasised || p.highlight ? " hl" : ""}`}
                  d={smoothPath(points)}
                  style={{ stroke: p.highlight ? "var(--danger)" : `var(--cat-${p.category})` }}
                  stroke-dasharray={cat.dash}
                  marker-end={`url(#arrow-${p.category})`}
                >
                  {p.types.length > 0 && <title>{p.types.map((t) => t.replace(/_/g, " ").toLowerCase()).join(", ")}</title>}
                </path>
              );
            })}
          </g>
          <g class="nodes">
            {[...layout.nodes].map(([id, box]) => {
              const x = box.x - box.width / 2;
              const y = box.y - box.height / 2;
              if (id === STUB_IN || id === STUB_OUT) {
                const stub = id === STUB_IN ? props.stubs?.in : props.stubs?.out;
                return (
                  <g class="node stub" ref={track(id)} transform={`translate(${x},${y})`} role="button" tabIndex={0} aria-label={`Show more: ${stub?.more} more neighbours`} onClick={() => stub?.onMore()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); stub?.onMore(); } }}>
                    <rect width={box.width} height={NODE_HEIGHT} rx="8" />
                    <text x={box.width / 2} y={NODE_HEIGHT / 2 + 4} text-anchor="middle">{`+${stub?.more} more · show more`}</text>
                  </g>
                );
              }
              const node = byId.get(id);
              if (!node) return null;
              const sub = subtitle(node);
              const dim = (neighbours && !neighbours.has(id)) || (props.pathIds && !props.pathIds.has(id));
              const w = nodeWidth(node.name, sub);
              return (
                <g
                  class={`node${id === centerId ? " center" : ""}${dim ? " dim" : ""}${props.pathIds?.has(id) ? " on-path" : ""}`}
                  ref={track(id)}
                  transform={`translate(${x},${y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.label} ${node.name}`}
                  onMouseEnter={() => setHovered(id)}
                  onMouseLeave={() => setHovered((h) => (h === id ? null : h))}
                  onFocus={() => setHovered(id)}
                  onBlur={() => setHovered((h) => (h === id ? null : h))}
                  onClick={(e) => activate(id, e)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(id, e); } }}
                >
                  <title>{`${node.label}: ${node.name}${sub ? `\n${sub}` : ""}`}</title>
                  <rect width={w} height={NODE_HEIGHT} rx="8" />
                  <KindGlyphSvg label={node.label} x={11} y={13} />
                  <text class="n-name" x="32" y={sub ? 17 : 24}>{clip(node.name, w)}</text>
                  {sub && <text class="n-sub" x="32" y="31">{clip(sub, w)}</text>}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <ZoomControls onIn={zoomIn} onOut={zoomOut} onFit={() => fit(layout.width, layout.height)} />
    </div>
  );
}
