import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { nodeLabels, openGraphStore, relationshipTables, type IGraphStore } from "../core.js";
import { HIDDEN_LABELS, kindOf, type EdgeKind } from "./kinds.js";

export type IndexNode = { id: string; label: string; props: Record<string, unknown> };
export type IndexEdge = { from: string; to: string; type: string; kind: EdgeKind; props: Record<string, unknown> };

/** The whole graph in memory, with the derived (collapsed) edges the views use. */
export type GraphIndex = {
  projectPath: string;
  nodes: Map<string, IndexNode>;
  /** Stored relationships, except those that touch a Call or Import node (collapsed into `edges`). */
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

/** What `<graph dir>/HEAD.json` says; the store rewrites it atomically on every commit. */
export type GraphHead = { schemaVersion: number | null; generation: number | null; writtenAt: string | null; nodes: number | null; mtimeMs: number };

/** Reads the store's manifest without opening the store (no snapshot is loaded). Null when the folder has no graph. */
export async function readGraphHead(graphDir: string): Promise<GraphHead | null> {
  const file = path.join(graphDir, "HEAD.json");
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const body = await readFile(file, "utf8").then(JSON.parse, () => null);
  if (typeof body !== "object" || body === null) return null;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    schemaVersion: num(body.schemaVersion),
    generation: num(body.generation),
    writtenAt: typeof body.writtenAt === "string" ? body.writtenAt : null,
    nodes: num(body.nodes),
    mtimeMs: info.mtimeMs,
  };
}

async function signatureOf(projectPath: string): Promise<string> {
  const head = await readGraphHead(graphPath(projectPath));
  if (!head) throw new Error("no graph");
  return `${head.generation ?? head.mtimeMs}:${head.writtenAt ?? head.mtimeMs}`;
}

const cache = new Map<string, GraphIndex>();
/** One build per project at a time: concurrent requests wait for the same promise. */
const building = new Map<string, { signature: string; promise: Promise<GraphIndex> }>();

export async function loadIndex(projectPath: string): Promise<GraphIndex> {
  const resolved = path.resolve(projectPath);
  const signature = await signatureOf(resolved).catch(() => {
    throw new Error(`No graph in ${resolved}; scan the project first`);
  });
  const cached = cache.get(resolved);
  if (cached && cached.signature === signature) return cached;
  const running = building.get(resolved);
  if (running && running.signature === signature) return running.promise;
  const entry: { signature: string; promise: Promise<GraphIndex> } = { signature, promise: undefined as never };
  entry.promise = (async () => {
    const store = await openGraphStore(graphPath(resolved), { retryLock: false });
    try {
      const index = await buildIndex(resolved, store, signature);
      // A scan that finished meanwhile invalidated this build: hand it to the waiting callers, do not keep it.
      if (building.get(resolved) === entry) cache.set(resolved, index);
      return index;
    } finally {
      await store.close();
      if (building.get(resolved) === entry) building.delete(resolved);
    }
  })();
  building.set(resolved, entry);
  return entry.promise;
}

export function invalidateIndex(projectPath: string): void {
  const resolved = path.resolve(projectPath);
  cache.delete(resolved);
  building.delete(resolved);
}

type RawNode = { id: string; label: string; properties: Record<string, unknown> };
type RawEdge = { from: string; to: string; type: string; properties: Record<string, unknown> };

/** The stored graph as written, Call and Import nodes included (the index leaves them out); for the whole-graph export. */
export async function readRawGraph(projectPath: string): Promise<{ nodes: RawNode[]; edges: RawEdge[] }> {
  const store = await openGraphStore(graphPath(path.resolve(projectPath)), { retryLock: false });
  try {
    const nodes: RawNode[] = [];
    for (const label of nodeLabels) {
      for (const { n } of (await store.query(`MATCH (n:${label}) RETURN n`)) as Array<{ n: Record<string, unknown> }>) {
        const { _label, id, ...properties } = n;
        nodes.push({ id: String(id), label, properties });
      }
    }
    const edges: RawEdge[] = [];
    for (const table of relationshipTables) {
      for (const { r } of (await store.query(`MATCH ()-[r:${table.type}]->() RETURN r`)) as Array<{ r: Record<string, unknown> }>) {
        const { _label, _src, _dst, ...properties } = r;
        edges.push({ from: String(_src), to: String(_dst), type: table.type, properties });
      }
    }
    return { nodes, edges };
  } finally {
    await store.close();
  }
}

/** Labels the index does not keep: they only carry the call and import edges, which are collapsed. */
const COLLAPSED = new Set(["Call", "Import"]);
/** Relationship types through a Call or Import that become derived edges, or only say who owns a Call. */
const THROUGH_COLLAPSED = new Set(["IMPORTS", "CALLS", "MODULE_CALLS", "PASSED_TO", "INITIALIZED_BY"]);

const FILE_OWNING = /^(DEFINES_|DECLARES_(?!ENV|CONFIG)|MODULE_CALLS|IMPORTS$)/;
const isOwnedChild = (type: string) => type === "DEFINES_METHOD" || type === "DEFINES_FIELD" || type.endsWith("HAS_DECORATOR") || type === "HAS_METHOD_DECORATOR" || type === "HAS_RPC";

type TypeSets = Map<string, Map<string, string | string[]>>;

/**
 * Builds the index table by table. Call and Import nodes are never read: the edges through them are
 * collapsed on the way (X -> Call -> Function becomes X -> Function), and only what the views need of a
 * Call (the function that made a request) is remembered for the few Calls that have a REQUESTS edge.
 * Relationships that touch a Call or Import are not kept in `stored`; the whole-graph export reads the raw graph.
 */
export async function buildIndex(projectPath: string, store: IGraphStore, signature: string): Promise<GraphIndex> {
  const nodes = new Map<string, IndexNode>();
  for (const label of nodeLabels) {
    if (COLLAPSED.has(label)) continue;
    const rows = (await store.query(`MATCH (n:${label}) RETURN n`)) as Array<{ n: Record<string, unknown> }>;
    for (let i = 0; i < rows.length; i++) {
      // The row is let go as soon as it is copied. (Deleting `_label`/`id` from the row instead keeps it as a
      // dictionary-mode object, which measured about 4x the retained memory of the rest copy.)
      const { _label, id, ...props } = rows[i]!.n;
      rows[i] = undefined as never;
      nodes.set(String(id), { id: String(id), label, props });
    }
  }

  const rowsOf = async (type: string) => (await store.query(`MATCH ()-[r:${type}]->() RETURN r`)) as Array<{ r: Record<string, unknown> }>;
  const pushTo = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  // Small side tables first: what Imports and Calls resolve to, and the Calls that make requests.
  const resolvesTo = new Map<string, string[]>();
  const callTargets = new Map<string, string[]>();
  for (const { r } of await rowsOf("RESOLVES_TO")) pushTo(resolvesTo, String(r._src), String(r._dst));
  for (const { r } of await rowsOf("CALL_RESOLVES_TO")) pushTo(callTargets, String(r._src), String(r._dst));
  const requests = await rowsOf("REQUESTS");
  const requestCalls = new Set<string>();
  for (const { r } of requests) requestCalls.add(String(r._src));
  // For those Calls only: the functions that call them and whatever owns them, in stored order.
  const callerFunctions = new Map<string, string[]>();
  const callOwners = new Map<string, string[]>();

  const stored: IndexEdge[] = [];
  const children = new Map<string, string[]>();
  const edges: IndexEdge[] = [];
  const seen: TypeSets = new Map();
  /** Adds an edge once per (from, to, type). */
  const add = (edge: IndexEdge, into: IndexEdge[], dedupe: TypeSets) => {
    if (edge.from === edge.to) return;
    let targets = dedupe.get(edge.from);
    if (!targets) dedupe.set(edge.from, (targets = new Map()));
    const known = targets.get(edge.to);
    if (known === undefined) targets.set(edge.to, edge.type);
    else if (typeof known === "string") {
      if (known === edge.type) return;
      targets.set(edge.to, [known, edge.type]);
    } else {
      if (known.includes(edge.type)) return;
      known.push(edge.type);
    }
    into.push(edge);
  };
  let requestsAt = 0;

  for (const table of relationshipTables) {
    const type = table.type;
    if (type === "RESOLVES_TO" || type === "CALL_RESOLVES_TO") continue;
    if (type === "REQUESTS") {
      // Added after ownership is known, at this position, so the edge order is the stored order.
      requestsAt = edges.length;
      continue;
    }
    const collapsed = COLLAPSED.has(table.from) || COLLAPSED.has(table.to);
    if (collapsed && !THROUGH_COLLAPSED.has(type)) continue;
    const rows = await rowsOf(type);
    const kind = kindOf(type);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!.r;
      rows[i] = undefined as never;
      const from = String(r._src);
      const to = String(r._dst);
      if (collapsed) {
        if (requestCalls.has(to)) {
          pushTo(callOwners, to, from);
          if (type === "CALLS") pushTo(callerFunctions, to, from);
        }
        if (!nodes.has(from)) continue;
        if (type === "IMPORTS") {
          for (const target of resolvesTo.get(to) ?? []) add({ from, to: target, type: "IMPORTS", kind: "imports", props: {} }, edges, seen);
        } else if (type === "CALLS" || type === "MODULE_CALLS") {
          for (const target of callTargets.get(to) ?? []) add({ from, to: target, type: "CALLS", kind: "calls", props: {} }, edges, seen);
        }
        continue;
      }
      const { _label, _src, _dst, ...props } = r;
      const edge: IndexEdge = { from, to, type, kind, props };
      stored.push(edge);
      const fromNode = nodes.get(from);
      if (fromNode?.label === "File" && FILE_OWNING.test(type)) pushTo(children, from, to);
      else if (isOwnedChild(type)) pushTo(children, from, to);
      const toNode = nodes.get(to);
      if (fromNode && toNode && !HIDDEN_LABELS.has(fromNode.label) && !HIDDEN_LABELS.has(toNode.label)) add(edge, edges, seen);
    }
  }

  // Ownership: which File each node was declared in.
  const fileOf = new Map<string, string>();
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
  children.clear();

  const declared = new Map<string, string[]>();
  for (const [id, owner] of fileOf) if (id !== owner) pushTo(declared, owner, id);

  const packageOf = new Map<string, string>();
  for (const edge of stored) {
    if (edge.type !== "PACKAGE_CONTAINS_FILE") continue;
    packageOf.set(edge.to, String(nodes.get(edge.from)?.props.name ?? edge.from));
  }

  // The Call is hidden: attribute the request to the function that made it, else to the file that owns the call.
  const requestEdges: IndexEdge[] = [];
  const requestSeen: TypeSets = new Map();
  for (const { r } of requests) {
    const call = String(r._src);
    const route = String(r._dst);
    if (!nodes.has(route)) continue;
    const callerFunction = (callerFunctions.get(call) ?? []).find((id) => nodes.get(id)?.label === "Function");
    const file = (callOwners.get(call) ?? []).map((owner) => fileOf.get(owner)).find((id) => id !== undefined && nodes.has(id));
    const origin = callerFunction ?? file;
    if (!origin) continue;
    const { _label, _src, _dst, ...props } = r;
    add({ from: origin, to: route, type: "REQUESTS", kind: "requests", props }, requestEdges, requestSeen);
  }
  const ordered = requestEdges.length === 0 ? edges : edges.slice(0, requestsAt).concat(requestEdges, edges.slice(requestsAt));

  const out = new Map<string, IndexEdge[]>();
  const inn = new Map<string, IndexEdge[]>();
  for (const edge of ordered) {
    pushTo(out, edge.from, edge);
    pushTo(inn, edge.to, edge);
  }
  const repo = [...nodes.values()].find((n) => n.label === "Repo");
  return { projectPath, nodes, stored, edges: ordered, out, inn, fileOf, declared, packageOf, signature, schemaVersion: await store.schemaVersion(), rootPath: String(repo?.props.path ?? projectPath) };
}

export function nodeName(node: IndexNode): string {
  const p = node.props;
  if (node.label === "File") return String(p.relativePath ?? node.id);
  if (node.label === "Route") return `${p.method ?? ""} ${p.fullPath ?? p.path ?? ""}`.trim();
  if (node.label === "Function" && p.className) return `${p.className}.${p.name}`;
  return String(p.name ?? p.path ?? p.relativePath ?? p.selector ?? node.id);
}
