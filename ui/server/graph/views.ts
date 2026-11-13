import { readFile } from "node:fs/promises";
import path from "node:path";
import { graphSummary, matchName, openGraphStore } from "../core.js";
import { graphPath, loadIndex, nodeName, type GraphIndex, type IndexEdge, type IndexNode } from "./index.js";
import { clusterOf } from "../../shared/clusters.js";
import { EDGE_KINDS, HIDDEN_LABELS, type EdgeKind } from "./kinds.js";

export const MAX_OVERVIEW_NODES = 5000;
export const MAX_NEIGHBORS = 300;
const MAX_SOURCE_LINES = 400;

export async function summary(projectPath: string): Promise<unknown> {
  await loadIndex(projectPath); // fails with a clear message when there is no graph
  const store = await openGraphStore(graphPath(path.resolve(projectPath)), { retryLock: false });
  try {
    return await graphSummary(store);
  } finally {
    await store.close();
  }
}

export type OverviewNode = { id: string; label: string; name: string; files: number; package: string | null; degree: number; noise: boolean };

const NOISE_SEGMENTS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "vendor", "__pycache__", "venv"]);

/** Dot-directories and build output: kept out of the way by default. */
export function isNoisePath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => (segment.startsWith(".") && segment.length > 1 && segment !== "..") || NOISE_SEGMENTS.has(segment));
}
export type OverviewEdge = { from: string; to: string; count: number; byKind: Partial<Record<EdgeKind, number>> };
export type Overview = { level: string; prefix: string; nodes: OverviewNode[]; edges: OverviewEdge[]; truncated: boolean; isolatedHidden: number };

// Above this many nodes, files without any relationship are left out of the overview.
const ISOLATED_LIMIT = 300;

const NONE = "(no package)";

export async function overview(projectPath: string, level: string, prefix = "", kinds?: Set<string>): Promise<Overview> {
  if (level !== "package" && level !== "directory" && level !== "file") throw new Error("level must be package, directory or file");
  const index = await loadIndex(projectPath);
  const files = [...index.nodes.values()].filter((n) => n.label === "File").filter((n) => relPath(n).startsWith(prefix));
  let depth = prefix === "" ? 0 : prefix.split("/").filter(Boolean).length;

  // Group key of every file at this level. A directory level with one single
  // directory in it goes down until there is something to compare.
  let keyOfFile = new Map<string, { id: string; label: string; name: string; package: string | null; noise: boolean }>();
  let groups = new Map<string, OverviewNode>();
  for (;;) {
    keyOfFile = new Map();
    for (const file of files) {
      const rel = relPath(file);
      const pkg = index.packageOf.get(file.id) ?? null;
      if (level === "package") {
        const name = pkg ?? NONE;
        keyOfFile.set(file.id, { id: `package:${name}`, label: "Package", name, package: pkg, noise: false });
      } else if (level === "directory") {
        const segments = rel.split("/");
        if (segments.length - 1 > depth) {
          const dir = segments.slice(0, depth + 1).join("/");
          keyOfFile.set(file.id, { id: `dir:${dir}`, label: "Directory", name: segments[depth]!, package: pkg, noise: isNoisePath(dir) });
        } else keyOfFile.set(file.id, { id: file.id, label: "File", name: rel, package: pkg, noise: isNoisePath(rel) });
      } else keyOfFile.set(file.id, { id: file.id, label: "File", name: rel, package: pkg, noise: isNoisePath(rel) });
    }
    groups = new Map();
    for (const key of keyOfFile.values()) {
      const group = groups.get(key.id);
      if (group) group.files += 1;
      else groups.set(key.id, { ...key, files: 1, degree: 0 });
    }
    const only = groups.size === 1 ? [...groups.values()][0]! : undefined;
    if (level === "directory" && only?.label === "Directory" && depth < 12) {
      depth += 1;
      prefix = only.id.slice(4);
      continue;
    }
    break;
  }

  const edgeMap = new Map<string, OverviewEdge>();
  const degree = new Map<string, number>();
  for (const edge of index.edges) {
    if (edge.kind === "defines") continue;
    if (kinds && !kinds.has(edge.kind)) continue;
    const a = keyOfFile.get(index.fileOf.get(edge.from) ?? "");
    const b = keyOfFile.get(index.fileOf.get(edge.to) ?? "");
    if (!a || !b || a.id === b.id) continue;
    const key = `${a.id}\0${b.id}`;
    let entry = edgeMap.get(key);
    if (!entry) edgeMap.set(key, (entry = { from: a.id, to: b.id, count: 0, byKind: {} }));
    entry.count += 1;
    entry.byKind[edge.kind] = (entry.byKind[edge.kind] ?? 0) + 1;
    degree.set(a.id, (degree.get(a.id) ?? 0) + 1);
    degree.set(b.id, (degree.get(b.id) ?? 0) + 1);
  }

  for (const node of groups.values()) node.degree = degree.get(node.id) ?? 0;
  let nodes = [...groups.values()];
  let isolatedHidden = 0;
  if (nodes.length > ISOLATED_LIMIT && level !== "package") {
    const connected = nodes.filter((n) => n.degree > 0);
    isolatedHidden = nodes.length - connected.length;
    nodes = connected;
  }
  let truncated = false;
  if (nodes.length > MAX_OVERVIEW_NODES) {
    nodes = nodes.sort((x, y) => (degree.get(y.id) ?? 0) - (degree.get(x.id) ?? 0)).slice(0, MAX_OVERVIEW_NODES);
    truncated = true;
  }
  const keep = new Set(nodes.map((n) => n.id));
  return { level, prefix, nodes, edges: [...edgeMap.values()].filter((e) => keep.has(e.from) && keep.has(e.to)), truncated, isolatedHidden };
}

export type FullNode = { id: string; label: string; name: string; group: string; degree: number; file: string | null; line: number | null };
export type FullEdge = { from: string; to: string; kind: EdgeKind };
export type FullGraph = { nodes: FullNode[]; edges: FullEdge[]; groups: Array<{ name: string; count: number }>; total: number; truncated: boolean; isolated: number };

export const DEFAULT_FULL_LIMIT = 20000;

/**
 * The whole graph for the first view: every visible node with a relationship of
 * the wanted kinds, and those relationships. Each node carries the folder cluster
 * of its file (deep enough to tell at least six clusters apart, at most three
 * levels) so the picture can place clusters apart. Above `limit` nodes the most
 * connected are kept.
 */
export async function fullGraph(projectPath: string, kinds?: Set<string>, limit = DEFAULT_FULL_LIMIT): Promise<FullGraph> {
  const index = await loadIndex(projectPath);
  const fileOf = (id: string) => { const owner = index.fileOf.get(id); return owner ? relPath(index.nodes.get(owner)!) : null; };

  const degree = new Map<string, number>();
  const edges: FullEdge[] = [];
  for (const edge of index.edges) {
    if (kinds && !kinds.has(edge.kind)) continue;
    const a = index.nodes.get(edge.from);
    const b = index.nodes.get(edge.to);
    if (!a || !b || HIDDEN_LABELS.has(a.label) || HIDDEN_LABELS.has(b.label)) continue;
    edges.push({ from: edge.from, to: edge.to, kind: edge.kind });
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const visible = [...index.nodes.values()].filter((n) => !HIDDEN_LABELS.has(n.label) && n.label !== "Repo");
  const connected = visible.filter((n) => (degree.get(n.id) ?? 0) > 0);
  const isolated = visible.length - connected.length;

  let kept = connected;
  let truncated = false;
  if (kept.length > limit) {
    kept = [...kept].sort((x, y) => (degree.get(y.id) ?? 0) - (degree.get(x.id) ?? 0)).slice(0, limit);
    truncated = true;
  }
  const ids = new Set(kept.map((n) => n.id));

  const files = kept.map((n) => fileOf(n.id) ?? (n.label === "Directory" ? `${relPath(n) || String(n.props.path ?? "")}/x` : null));
  const clusters = clusterOf(files);

  const counts = new Map<string, number>();
  const nodes = kept.map((n, i): FullNode => {
    const group = clusters[i]!;
    counts.set(group, (counts.get(group) ?? 0) + 1);
    return { id: n.id, label: n.label, name: nodeName(n), group, degree: degree.get(n.id) ?? 0, file: fileOf(n.id), line: typeof n.props.line === "number" ? n.props.line : null };
  });
  return {
    nodes,
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    groups: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    total: connected.length,
    truncated,
    isolated,
  };
}

const relPath = (file: IndexNode) => String(file.props.relativePath ?? "");

export type ViewNode = { id: string; label: string; name: string; file: string | null; line: number | null; package: string | null };
export type ViewEdge = { from: string; to: string; type: string; kind: EdgeKind };

export function viewNode(index: GraphIndex, node: IndexNode): ViewNode {
  const file = index.fileOf.get(node.id);
  return {
    id: node.id,
    label: node.label,
    name: nodeName(node),
    file: file ? relPath(index.nodes.get(file)!) : null,
    line: typeof node.props.line === "number" ? node.props.line : null,
    package: file ? index.packageOf.get(file) ?? null : null,
  };
}

const declaredIn = (index: GraphIndex, fileId: string): string[] => index.declared.get(fileId) ?? [];

export async function neighbors(projectPath: string, id: string, kinds: Set<string> | undefined, depth: number) {
  const index = await loadIndex(projectPath);
  const start = index.nodes.get(id);
  if (!start) throw new Error(`Unknown node: ${id}`);
  const wanted = (edge: IndexEdge) => !kinds || kinds.has(edge.kind);
  const nodes = new Map<string, IndexNode>([[id, start]]);
  const edges = new Map<string, IndexEdge>();
  let truncated = false;
  let frontier = [id];
  const reach = (from: string, edge: IndexEdge, other: string) => {
    const node = index.nodes.get(other);
    if (!node || (nodes.size >= MAX_NEIGHBORS && !nodes.has(other))) {
      truncated ||= !!node;
      return;
    }
    edges.set(`${edge.from}\0${edge.to}\0${edge.type}`, edge);
    if (!nodes.has(other)) {
      nodes.set(other, node);
      next.push(other);
    }
  };
  let next: string[] = [];
  for (let level = 0; level < Math.max(1, Math.min(depth, 3)); level++) {
    next = [];
    for (const current of frontier) {
      for (const edge of index.out.get(current) ?? []) if (wanted(edge)) reach(current, edge, edge.to);
      for (const edge of index.inn.get(current) ?? []) if (wanted(edge)) reach(current, edge, edge.from);
      // A file also brings its declarations when structure is asked for.
      if (index.nodes.get(current)?.label === "File" && (!kinds || kinds.has("defines"))) {
        for (const child of declaredIn(index, current)) {
          const node = index.nodes.get(child);
          if (!node || ["Call", "Import", "Decorator", "Field"].includes(node.label)) continue;
          if (nodes.size >= MAX_NEIGHBORS) { truncated = true; break; }
          if (!nodes.has(child)) { nodes.set(child, node); next.push(child); }
          edges.set(`${current}\0${child}\0DEFINES`, { from: current, to: child, type: "DEFINES", kind: "defines", props: {} });
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: [...nodes.values()].map((n) => viewNode(index, n)),
    edges: [...edges.values()].map((e): ViewEdge => ({ from: e.from, to: e.to, type: e.type, kind: e.kind })),
    truncated,
  };
}

export async function nodeDetail(projectPath: string, id: string) {
  const index = await loadIndex(projectPath);
  const node = index.nodes.get(id);
  if (!node) throw new Error(`Unknown node: ${id}`);
  const describe = (edge: IndexEdge, otherId: string) => {
    const other = index.nodes.get(otherId);
    return { type: edge.type, kind: edge.kind, id: otherId, label: other?.label ?? "?", name: other ? nodeName(other) : otherId };
  };
  const outgoing = (index.out.get(id) ?? []).map((e) => describe(e, e.to));
  const incoming = (index.inn.get(id) ?? []).map((e) => describe(e, e.from));
  const fileId = index.fileOf.get(id);
  const file = fileId ? index.nodes.get(fileId) : undefined;
  return {
    id,
    label: node.label,
    name: nodeName(node),
    properties: Object.fromEntries(Object.entries(node.props).filter(([, v]) => v !== null && v !== "")),
    file: file ? relPath(file) : null,
    line: typeof node.props.line === "number" ? node.props.line : null,
    endLine: typeof node.props.endLine === "number" ? node.props.endLine : null,
    outgoing: groupByType(outgoing),
    incoming: groupByType(incoming),
  };
}

function groupByType<T extends { type: string }>(items: T[]): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[item.type] ??= []).push(item);
  for (const key of Object.keys(groups)) groups[key] = groups[key]!.slice(0, 50);
  return groups;
}

/** The source text of a declaration (or a whole file), refused outside the project. */
export async function nodeSource(projectPath: string, id: string) {
  const index = await loadIndex(projectPath);
  const node = index.nodes.get(id);
  if (!node) throw new Error(`Unknown node: ${id}`);
  const fileId = index.fileOf.get(id);
  const file = fileId ? index.nodes.get(fileId) : undefined;
  if (!file) return { source: null, note: "This node has no source file." };
  const root = path.resolve(projectPath);
  const absolute = path.resolve(root, relPath(file));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error("Refusing to read outside the project");
  const text = await readFile(absolute, "utf8").catch(() => null);
  if (text === null) return { file: relPath(file), source: null, note: "The file could not be read." };
  const lines = text.split(/\r?\n/);
  const isFile = node.label === "File";
  const start = isFile ? 1 : typeof node.props.line === "number" ? node.props.line : 1;
  const end = isFile ? lines.length : typeof node.props.endLine === "number" ? node.props.endLine : start;
  const shownEnd = Math.min(end, start + MAX_SOURCE_LINES - 1);
  return { file: relPath(file), line: start, endLine: end, source: lines.slice(start - 1, shownEnd).join("\n"), truncated: shownEnd < end };
}

const SEARCHABLE = new Set(["File", "Function", "Class", "Interface", "TypeAlias", "Enum", "Variable", "Route", "Component", "Page", "Table", "DataModel", "EnvVar", "EntryPoint", "Store", "Service", "Rpc", "Message"]);

export async function search(projectPath: string, query: string, label: string | undefined, limit = 50) {
  const q = query.trim();
  if (q.length === 0) throw new Error("q must not be blank");
  const index = await loadIndex(projectPath);
  const hits: Array<{ node: IndexNode; name: string; match: string; score: number }> = [];
  for (const node of index.nodes.values()) {
    if (!SEARCHABLE.has(node.label) || (label && node.label !== label)) continue;
    const name = nodeName(node);
    const target = node.label === "File" ? name.slice(name.lastIndexOf("/") + 1) : name;
    const m = matchName(target, q) ?? (node.label === "File" ? matchName(name, q) : null);
    if (m) hits.push({ node, name, ...m });
  }
  hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return { total: hits.length, results: hits.slice(0, limit).map((h) => ({ ...viewNode(index, h.node), match: h.match, score: h.score })) };
}

export function parseKinds(value: string | null): Set<string> | undefined {
  if (!value) return undefined;
  const kinds = value.split(",").filter(Boolean);
  const valid = new Set<string>([...EDGE_KINDS, "defines"]);
  for (const kind of kinds) if (!valid.has(kind)) throw new Error(`Unknown relationship kind: ${kind}`);
  return new Set(kinds);
}
