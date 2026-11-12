import { stat } from "node:fs/promises";
import path from "node:path";
import { nodeLabels, openGraphStore, relationshipTables, type IGraphStore } from "../core.js";
import { HIDDEN_LABELS, kindOf, type EdgeKind } from "./kinds.js";

export type IndexNode = { id: string; label: string; props: Record<string, unknown> };
export type IndexEdge = { from: string; to: string; type: string; kind: EdgeKind; props: Record<string, unknown> };

/** The whole graph in memory, with the derived (collapsed) edges the views use. */
export type GraphIndex = {
  projectPath: string;
  nodes: Map<string, IndexNode>;
  /** Stored relationships. */
  stored: IndexEdge[];
  /** Edges between visible nodes: direct ones plus imports and calls collapsed through Import / Call nodes. */
  edges: IndexEdge[];
  out: Map<string, IndexEdge[]>;
  inn: Map<string, IndexEdge[]>;
  /** Owning File node id of each node (a File owns itself). */
  fileOf: Map<string, string>;
  /** Declarations owned by each File node id. */
  declared: Map<string, string[]>;
  /** Package name of each File node id. */
  packageOf: Map<string, string>;
  signature: string;
  schemaVersion: number | null;
  rootPath: string;
};

export function graphPath(projectPath: string): string {
  return path.join(projectPath, ".concentrate", "graph");
}

async function signatureOf(projectPath: string): Promise<string> {
  const info = await stat(path.join(graphPath(projectPath), "HEAD")).catch(() => stat(graphPath(projectPath)));
  return `${info.mtimeMs}:${info.size}`;
}

const cache = new Map<string, GraphIndex>();

export async function loadIndex(projectPath: string): Promise<GraphIndex> {
  const resolved = path.resolve(projectPath);
  const signature = await signatureOf(resolved).catch(() => {
    throw new Error(`No graph in ${resolved}; scan the project first`);
  });
  const cached = cache.get(resolved);
  if (cached && cached.signature === signature) return cached;
  const store = await openGraphStore(graphPath(resolved), { retryLock: false });
  try {
    const index = await buildIndex(resolved, store, signature);
    cache.set(resolved, index);
    return index;
  } finally {
    await store.close();
  }
}

export function invalidateIndex(projectPath: string): void {
  cache.delete(path.resolve(projectPath));
}

const FILE_OWNING = /^(DEFINES_|DECLARES_(?!ENV|CONFIG)|MODULE_CALLS|IMPORTS$)/;

export async function buildIndex(projectPath: string, store: IGraphStore, signature: string): Promise<GraphIndex> {
  const nodes = new Map<string, IndexNode>();
  for (const label of nodeLabels) {
    const rows = (await store.query(`MATCH (n:${label}) RETURN n`)) as Array<{ n: Record<string, unknown> }>;
    for (const { n } of rows) {
      const { _label, id, ...props } = n;
      nodes.set(String(id), { id: String(id), label, props });
    }
  }
  const stored: IndexEdge[] = [];
  for (const table of relationshipTables) {
    const rows = (await store.query(`MATCH ()-[r:${table.type}]->() RETURN r`)) as Array<{ r: Record<string, unknown> }>;
    const kind = kindOf(table.type);
    for (const { r } of rows) {
      const { _label, _src, _dst, ...props } = r;
      stored.push({ from: String(_src), to: String(_dst), type: table.type, kind, props });
    }
  }

  // Ownership: which File each node was declared in.
  const fileOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  const push = (from: string, to: string) => {
    const list = children.get(from);
    if (list) list.push(to);
    else children.set(from, [to]);
  };
  for (const edge of stored) {
    const fromLabel = nodes.get(edge.from)?.label;
    if (fromLabel === "File" && FILE_OWNING.test(edge.type)) push(edge.from, edge.to);
    else if (edge.type === "DEFINES_METHOD" || edge.type === "DEFINES_FIELD" || edge.type.endsWith("HAS_DECORATOR") || edge.type === "HAS_DECORATOR" || edge.type === "HAS_METHOD_DECORATOR" || edge.type === "CALLS" || edge.type === "PASSED_TO" || edge.type === "INITIALIZED_BY" || edge.type === "HAS_RPC") push(edge.from, edge.to);
  }
  for (const node of nodes.values()) {
    if (node.label !== "File") continue;
    fileOf.set(node.id, node.id);
    const queue = [node.id];
    while (queue.length > 0) {
      for (const child of children.get(queue.pop()!) ?? []) {
        if (fileOf.has(child)) continue;
        fileOf.set(child, node.id);
        queue.push(child);
      }
    }
  }

  const declared = new Map<string, string[]>();
  for (const [id, owner] of fileOf) if (id !== owner) (declared.get(owner) ?? declared.set(owner, []).get(owner)!).push(id);

  const packageOf = new Map<string, string>();
  for (const edge of stored) {
    if (edge.type !== "PACKAGE_CONTAINS_FILE") continue;
    packageOf.set(edge.to, String(nodes.get(edge.from)?.props.name ?? edge.from));
  }

  // Derived edges: skip hidden nodes, collapse File→Import→File and X→Call→Function.
  const resolvesTo = new Map<string, string[]>();
  const callTargets = new Map<string, string[]>();
  for (const edge of stored) {
    if (edge.type === "RESOLVES_TO") (resolvesTo.get(edge.from) ?? resolvesTo.set(edge.from, []).get(edge.from)!).push(edge.to);
    if (edge.type === "CALL_RESOLVES_TO") (callTargets.get(edge.from) ?? callTargets.set(edge.from, []).get(edge.from)!).push(edge.to);
  }
  const edges: IndexEdge[] = [];
  const seen = new Set<string>();
  const add = (edge: IndexEdge) => {
    const key = `${edge.from}\0${edge.to}\0${edge.type}`;
    if (seen.has(key) || edge.from === edge.to) return;
    seen.add(key);
    edges.push(edge);
  };
  for (const edge of stored) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    if (edge.type === "IMPORTS") {
      for (const target of resolvesTo.get(edge.to) ?? []) add({ from: edge.from, to: target, type: "IMPORTS", kind: "imports", props: {} });
    } else if (edge.type === "CALLS" || edge.type === "MODULE_CALLS") {
      for (const target of callTargets.get(edge.to) ?? []) add({ from: edge.from, to: target, type: "CALLS", kind: "calls", props: {} });
    } else if (edge.type === "REQUESTS") {
      const caller = fileOf.get(edge.from);
      const callerNode = caller ? nodes.get(caller) : undefined;
      // The Call is hidden: attribute the request to the function that made it, else the file.
      const origin = [...(inEdgesOfCall(stored, edge.from))].find((id) => nodes.get(id)?.label === "Function") ?? callerNode?.id;
      if (origin) add({ from: origin, to: edge.to, type: "REQUESTS", kind: "requests", props: edge.props });
    } else if (!HIDDEN_LABELS.has(from.label) && !HIDDEN_LABELS.has(to.label) && edge.type !== "RESOLVES_TO" && edge.type !== "CALL_RESOLVES_TO" && edge.type !== "IMPORTS_PACKAGE") {
      add(edge);
    }
  }
  const out = new Map<string, IndexEdge[]>();
  const inn = new Map<string, IndexEdge[]>();
  for (const edge of edges) {
    (out.get(edge.from) ?? out.set(edge.from, []).get(edge.from)!).push(edge);
    (inn.get(edge.to) ?? inn.set(edge.to, []).get(edge.to)!).push(edge);
  }
  const repo = [...nodes.values()].find((n) => n.label === "Repo");
  return { projectPath, nodes, stored, edges, out, inn, fileOf, declared, packageOf, signature, schemaVersion: await store.schemaVersion(), rootPath: String(repo?.props.path ?? projectPath) };
}

// Callers of a Call node (the Functions with a CALLS edge to it).
const callerCache = new WeakMap<IndexEdge[], Map<string, string[]>>();
function inEdgesOfCall(stored: IndexEdge[], callId: string): string[] {
  let map = callerCache.get(stored);
  if (!map) {
    map = new Map();
    for (const edge of stored) if (edge.type === "CALLS") (map.get(edge.to) ?? map.set(edge.to, []).get(edge.to)!).push(edge.from);
    callerCache.set(stored, map);
  }
  return map.get(callId) ?? [];
}

export function nodeName(node: IndexNode): string {
  const p = node.props;
  if (node.label === "File") return String(p.relativePath ?? node.id);
  if (node.label === "Route") return `${p.method ?? ""} ${p.fullPath ?? p.path ?? ""}`.trim();
  if (node.label === "Function" && p.className) return `${p.className}.${p.name}`;
  return String(p.name ?? p.path ?? p.relativePath ?? p.selector ?? node.id);
}
