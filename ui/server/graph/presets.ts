import { loadIndex, nodeName, type GraphIndex, type IndexEdge } from "./index.js";
import { MAX_OVERVIEW_NODES, type ViewEdge, type ViewNode } from "./views.js";

export const PRESETS = ["routes-handlers-tables", "requests-routes", "component-tree", "import-cycles"] as const;
export type Preset = (typeof PRESETS)[number];

export type PresetResult = {
  preset: Preset;
  nodes: ViewNode[];
  edges: Array<ViewEdge & { highlight?: boolean }>;
  truncated: boolean;
  note: string;
};

function viewNode(index: GraphIndex, id: string): ViewNode {
  const node = index.nodes.get(id)!;
  const file = index.fileOf.get(id);
  return {
    id,
    label: node.label,
    name: nodeName(node),
    file: file ? String(index.nodes.get(file)?.props.relativePath ?? "") : null,
    line: typeof node.props.line === "number" ? node.props.line : null,
    package: file ? index.packageOf.get(file) ?? null : null,
  };
}

const toView = (e: IndexEdge): ViewEdge => ({ from: e.from, to: e.to, type: e.type, kind: e.kind });

// Keeps the most connected nodes when a preset is above the drawing cap.
function cap(index: GraphIndex, ids: Set<string>, edges: IndexEdge[]) {
  if (ids.size <= MAX_OVERVIEW_NODES) return { ids, edges, truncated: false };
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const kept = new Set([...ids].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0)).slice(0, MAX_OVERVIEW_NODES));
  return { ids: kept, edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)), truncated: true };
}

function result(index: GraphIndex, preset: Preset, ids: Set<string>, edges: IndexEdge[], note: string, highlight?: Set<IndexEdge>): PresetResult {
  const capped = cap(index, ids, edges);
  return {
    preset,
    nodes: [...capped.ids].map((id) => viewNode(index, id)),
    edges: capped.edges.map((e) => ({ ...toView(e), ...(highlight?.has(e) ? { highlight: true } : {}) })),
    truncated: capped.truncated,
    note: capped.truncated ? `${note} Above ${MAX_OVERVIEW_NODES} nodes, so only the most connected are shown.` : note,
  };
}

const sourceIds = (index: GraphIndex, label: string) => [...index.nodes.values()].filter((n) => n.label === label).map((n) => n.id);

export async function preset(projectPath: string, name: string): Promise<PresetResult> {
  const index = await loadIndex(projectPath);
  switch (name) {
    case "routes-handlers-tables": {
      const ids = new Set<string>();
      const edges: IndexEdge[] = [];
      const take = (e: IndexEdge) => { edges.push(e); ids.add(e.from); ids.add(e.to); };
      for (const route of sourceIds(index, "Route")) {
        for (const e of index.out.get(route) ?? []) {
          if (e.type === "ROUTE_HANDLED_BY") {
            take(e);
            for (const d of index.out.get(e.to) ?? []) if (d.kind === "data") take(d);
          } else if (e.kind === "data") take(e);
        }
      }
      return result(index, name, ids, edges, "Routes, the functions that handle them and the tables or models they read and write.");
    }
    case "requests-routes": {
      const ids = new Set<string>();
      const edges: IndexEdge[] = [];
      for (const e of index.edges) {
        if (e.kind !== "requests") continue;
        edges.push(e);
        ids.add(e.from).add(e.to);
        for (const h of index.out.get(e.to) ?? []) if (h.type === "ROUTE_HANDLED_BY") { edges.push(h); ids.add(h.to); }
      }
      return result(index, name, ids, edges, "Frontend requests, the backend routes they reach and the handlers of those routes.");
    }
    case "component-tree": {
      const ids = new Set<string>();
      const edges: IndexEdge[] = [];
      for (const e of index.edges) {
        if (e.type !== "RENDERS" && e.type !== "PAGE_RENDERS") continue;
        edges.push(e);
        ids.add(e.from).add(e.to);
      }
      return result(index, name, ids, edges, "Pages and components, and which renders which.");
    }
    case "import-cycles": {
      const fileEdges = index.edges.filter((e) => e.type === "IMPORTS" && index.nodes.get(e.from)?.label === "File" && index.nodes.get(e.to)?.label === "File");
      const components = stronglyConnected(fileEdges).filter((c) => c.length > 1);
      const inCycle = new Set(components.flat());
      const edges = fileEdges.filter((e) => inCycle.has(e.from) && inCycle.has(e.to) && componentOf(components, e.from) === componentOf(components, e.to));
      return result(index, name, inCycle, edges, `${components.length} groups of files that import each other, directly or indirectly.`, new Set(edges));
    }
    default:
      throw new Error(`Unknown preset: ${name}; expected one of ${PRESETS.join(", ")}`);
  }
}

function componentOf(components: string[][], id: string): number {
  return components.findIndex((c) => c.includes(id));
}

/** Strongly connected components of a directed graph (iterative Tarjan). */
export function stronglyConnected(edges: IndexEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    (adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to);
    if (!adjacency.has(e.to)) adjacency.set(e.to, []);
  }
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of adjacency.keys()) {
    if (indexOf.has(root)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    indexOf.set(root, counter); low.set(root, counter++); stack.push(root); onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = adjacency.get(frame.node)!;
      if (frame.next < targets.length) {
        const to = targets[frame.next++]!;
        if (!indexOf.has(to)) {
          indexOf.set(to, counter); low.set(to, counter++); stack.push(to); onStack.add(to);
          work.push({ node: to, next: 0 });
        } else if (onStack.has(to)) low.set(frame.node, Math.min(low.get(frame.node)!, indexOf.get(to)!));
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!.node;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
        }
        if (low.get(frame.node) === indexOf.get(frame.node)) {
          const component: string[] = [];
          let member: string;
          do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== frame.node);
          out.push(component);
        }
      }
    }
  }
  return out;
}
