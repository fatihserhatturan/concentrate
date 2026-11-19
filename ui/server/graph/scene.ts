// The whole graph of a large project, one folder level at a time. The picture is
// a partition of every connected node: a folder that is not open is one item (a
// cluster), and an open folder shows its subfolders as clusters and its own nodes
// one by one. Relationships are added up between the items, so the picture keeps
// every relationship however little of it is open.
import { loadIndex, nodeName, type GraphIndex } from "./index.js";
import { HIDDEN_LABELS, type EdgeKind } from "./kinds.js";

/** Folder of the nodes no file owns (routes, tables, env vars…). */
export const OTHER = "(other)";
export const DEFAULT_LEAF_LIMIT = 1500;
const MAX_LEAF_LIMIT = 5000;
const MAX_OPEN = 400;

export type SceneCluster = {
  type: "cluster"; id: string; path: string; name: string; parent: string;
  /** Connected nodes inside, at any depth; those directly in the folder; subfolders with nodes. */
  nodes: number; direct: number; children: number; label: string;
};
export type SceneLeaf = {
  type: "node"; id: string; label: string; name: string; parent: string; degree: number; file: string | null; line: number | null;
};
export type SceneEdge = { from: string; to: string; count: number; kind: EdgeKind };
export type Scene = {
  items: Array<SceneCluster | SceneLeaf>;
  edges: SceneEdge[];
  /** Connected nodes in the whole graph, nodes left out for having no relationship, and nodes of open folders left out by the limit. */
  total: number; isolated: number; hidden: Record<string, number>;
};

/** `dir:<path>`; the project root is the empty string. */
export const clusterId = (path: string) => `dir:${path}`;

type Base = { degree: Map<string, number>; nodes: Array<{ id: string; dir: string }>; isolated: number };
const bases = new WeakMap<GraphIndex, Map<string, Base>>();

/** Degree of every node for the wanted kinds and the folder of each connected node: the same for every scene of one graph and kinds. */
function base(index: GraphIndex, kinds: Set<string> | undefined): Base {
  const key = kinds ? [...kinds].sort().join(",") : "*";
  let perIndex = bases.get(index);
  if (!perIndex) bases.set(index, (perIndex = new Map()));
  const cached = perIndex.get(key);
  if (cached) return cached;

  const degree = new Map<string, number>();
  for (const edge of index.edges) {
    if (kinds && !kinds.has(edge.kind)) continue;
    const a = index.nodes.get(edge.from);
    const b = index.nodes.get(edge.to);
    if (!a || !b || HIDDEN_LABELS.has(a.label) || HIDDEN_LABELS.has(b.label)) continue;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const nodes: Base["nodes"] = [];
  let isolated = 0;
  for (const node of index.nodes.values()) {
    if (HIDDEN_LABELS.has(node.label) || node.label === "Repo") continue;
    if (!degree.get(node.id)) { isolated += 1; continue; }
    nodes.push({ id: node.id, dir: dirOf(index, node.id) });
  }
  if (perIndex.size >= 4) perIndex.delete(perIndex.keys().next().value!);
  const result = { degree, nodes, isolated };
  perIndex.set(key, result);
  return result;
}

/** Folder a node sits in: its file's folder; a folder node sits in itself. */
function dirOf(index: GraphIndex, id: string): string {
  const node = index.nodes.get(id)!;
  if (node.label === "Directory") return String(node.props.relativePath ?? "");
  const owner = index.fileOf.get(id);
  if (!owner) return OTHER;
  const rel = String(index.nodes.get(owner)?.props.relativePath ?? "");
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "" : rel.slice(0, slash);
}

export async function scene(projectPath: string, open: string[], kinds?: Set<string>, leafLimit = DEFAULT_LEAF_LIMIT): Promise<Scene> {
  const index = await loadIndex(projectPath);
  const { degree, nodes, isolated } = base(index, kinds);
  const opened = new Set(open.slice(0, MAX_OPEN).filter((p) => typeof p === "string"));
  opened.add("");
  const limit = Math.max(1, Math.min(MAX_LEAF_LIMIT, Number.isFinite(leafLimit) ? leafLimit : DEFAULT_LEAF_LIMIT));

  // Which item stands for each folder: the outermost closed folder on its way down, or the folder itself when all of them are open.
  type Place = { cluster: string; next: string | null } | { leafOf: string };
  const places = new Map<string, Place>();
  const placeOf = (dir: string): Place => {
    let place = places.get(dir);
    if (place) return place;
    place = { leafOf: dir };
    if (dir !== "") {
      const segments = dir.split("/");
      for (let i = 1; i <= segments.length; i++) {
        const path = segments.slice(0, i).join("/");
        if (!opened.has(path)) { place = { cluster: path, next: i < segments.length ? segments[i]! : null }; break; }
      }
    }
    places.set(dir, place);
    return place;
  };

  const clusters = new Map<string, SceneCluster & { kids: Set<string>; labels: Map<string, number> }>();
  const leaves = new Map<string, Array<{ id: string; degree: number }>>();
  for (const node of nodes) {
    const place = placeOf(node.dir);
    if ("leafOf" in place) {
      (leaves.get(place.leafOf) ?? leaves.set(place.leafOf, []).get(place.leafOf)!).push({ id: node.id, degree: degree.get(node.id)! });
      continue;
    }
    let cluster = clusters.get(place.cluster);
    if (!cluster) {
      const slash = place.cluster.lastIndexOf("/");
      cluster = {
        type: "cluster", id: clusterId(place.cluster), path: place.cluster, name: slash < 0 ? place.cluster : place.cluster.slice(slash + 1),
        parent: clusterId(slash < 0 ? "" : place.cluster.slice(0, slash)), nodes: 0, direct: 0, children: 0, label: "", kids: new Set(), labels: new Map(),
      };
      clusters.set(place.cluster, cluster);
    }
    cluster.nodes += 1;
    if (place.next === null) cluster.direct += 1; else cluster.kids.add(place.next);
    const label = index.nodes.get(node.id)!.label;
    cluster.labels.set(label, (cluster.labels.get(label) ?? 0) + 1);
  }

  // Each open folder shows its most connected nodes; the rest are counted.
  const itemOf = new Map<string, string>();
  const hidden: Record<string, number> = {};
  const items: Scene["items"] = [];
  for (const [dir, members] of leaves) {
    members.sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
    if (members.length > limit) hidden[clusterId(dir)] = members.length - limit;
    for (const member of members.slice(0, limit)) {
      itemOf.set(member.id, member.id);
      const node = index.nodes.get(member.id)!;
      const owner = index.fileOf.get(member.id);
      items.push({
        type: "node", id: member.id, label: node.label, name: nodeName(node), parent: clusterId(dir), degree: member.degree,
        file: owner ? String(index.nodes.get(owner)?.props.relativePath ?? "") || null : null, line: typeof node.props.line === "number" ? node.props.line : null,
      });
    }
  }
  for (const { kids, labels, ...cluster } of clusters.values()) {
    cluster.children = kids.size;
    cluster.label = [...labels].sort((a, b) => b[1] - a[1])[0]![0];
    items.push(cluster);
  }
  for (const node of nodes) {
    if (itemOf.has(node.id)) continue;
    const place = placeOf(node.dir);
    if ("cluster" in place) itemOf.set(node.id, clusterId(place.cluster));
  }

  const edges = new Map<string, SceneEdge & { kinds: Map<EdgeKind, number> }>();
  for (const edge of index.edges) {
    if (kinds && !kinds.has(edge.kind)) continue;
    const a = itemOf.get(edge.from);
    const b = itemOf.get(edge.to);
    if (!a || !b || a === b) continue;
    const key = `${a}\0${b}`;
    let entry = edges.get(key);
    if (!entry) edges.set(key, (entry = { from: a, to: b, count: 0, kind: edge.kind, kinds: new Map() }));
    entry.count += 1;
    entry.kinds.set(edge.kind, (entry.kinds.get(edge.kind) ?? 0) + 1);
  }

  return {
    items,
    edges: [...edges.values()].map(({ kinds: byKind, ...e }) => ({ ...e, kind: [...byKind].sort((x, y) => y[1] - x[1])[0]![0] })),
    total: nodes.length,
    isolated,
    hidden,
  };
}
