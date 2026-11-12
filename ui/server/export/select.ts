import { loadIndex, nodeName, type GraphIndex, type IndexEdge, type IndexNode } from "../graph/index.js";
import { HIDDEN_LABELS } from "../graph/kinds.js";
import { neighbors, overview, parseKinds, MAX_OVERVIEW_NODES } from "../graph/views.js";

export type ExportNode = { id: string; label: string; properties: Record<string, unknown> };
export type ExportEdge = { from: string; to: string; type: string; properties: Record<string, unknown> };
export type Selection = {
  index: GraphIndex;
  nodes: ExportNode[];
  edges: ExportEdge[];
  /** Set when the selection is a reduced view of what was asked for. */
  note?: string;
};
export type SelectOptions = { scope: "graph" | "view"; types?: string | null; prefix?: string; focus?: string };

const raw = (n: IndexNode): ExportNode => ({ id: n.id, label: n.label, properties: n.props });
const rawEdge = (e: IndexEdge): ExportEdge => ({ from: e.from, to: e.to, type: e.type, properties: e.props });

/** The nodes and relationships an export writes: the stored graph, or what the view shows. */
export async function select(projectPath: string, options: SelectOptions): Promise<Selection> {
  const index = await loadIndex(projectPath);
  if (options.scope === "graph") {
    return { index, nodes: [...index.nodes.values()].map(raw), edges: index.stored.map(rawEdge) };
  }
  const kinds = parseKinds(options.types ?? null);
  if (options.focus) {
    const around = await neighbors(projectPath, options.focus, kinds, 1);
    const ids = new Set(around.nodes.map((n) => n.id));
    const edges = index.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && (!kinds || kinds.has(e.kind)));
    return { index, nodes: [...ids].map((id) => raw(index.nodes.get(id)!)), edges: edges.map(rawEdge) };
  }
  // The overview view is file level: its files and the relationships between them.
  const prefix = options.prefix ?? "";
  const files = [...index.nodes.values()].filter((n) => n.label === "File" && String(n.props.relativePath ?? "").startsWith(prefix));
  const ids = new Set(files.map((f) => f.id));
  const pairs = new Map<string, ExportEdge & { count: number }>();
  for (const edge of index.edges) {
    if (edge.kind === "defines" || (kinds && !kinds.has(edge.kind))) continue;
    const a = index.fileOf.get(edge.from);
    const b = index.fileOf.get(edge.to);
    if (!a || !b || a === b || !ids.has(a) || !ids.has(b)) continue;
    const key = `${a}\0${b}\0${edge.kind}`;
    const entry = pairs.get(key) ?? pairs.set(key, { from: a, to: b, type: edge.kind.toUpperCase(), properties: { count: 0 }, count: 0 }).get(key)!;
    entry.count += 1;
    entry.properties = { count: entry.count };
  }
  return { index, nodes: files.map(raw), edges: [...pairs.values()].map(({ count: _c, ...e }) => e) };
}

export { nodeName, HIDDEN_LABELS, overview, MAX_OVERVIEW_NODES };
