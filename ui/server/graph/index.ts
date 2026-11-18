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

const stores = new Map<string, Promise<IGraphStore>>();

/**
 * The project's store, opened once and shared by every request: a reader follows new generations by itself,
 * and each open store holds its own copy of the graph (1.1 GB for Grafana), so opening one per request ran the
 * server out of memory. Never close it.
 */
export function projectStore(projectPath: string): Promise<IGraphStore> {
  const resolved = path.resolve(projectPath);
  let store = stores.get(resolved);
  if (!store) {
    store = openGraphStore(graphPath(resolved), { retryLock: false });
    stores.set(resolved, store);
    store.catch(() => stores.delete(resolved));
  }
  return store;
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
    try {
      const index = await buildIndex(resolved, await projectStore(resolved), signature);
      // A scan that finished meanwhile invalidated this build: hand it to the waiting callers, do not keep it.
      if (building.get(resolved) === entry) cache.set(resolved, index);
      return index;
    } finally {
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
  const store = await projectStore(projectPath);
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
  // One pass over the store's records, without query rows: nodes are kept per label (to insert them in schema
  // order, as the per-label queries did), relationships per type as three parallel arrays (no object per
  // relationship), and only the types the index reads. Properties are the store's own objects, not copies.
  const nodesByLabel = new Map<string, Array<[string, Readonly<Record<string, unknown>>]>>();
  type Bucket = { from: string[]; to: string[]; props: Array<Readonly<Record<string, unknown>>> };
  const kept = new Map<string, boolean>();
  for (const table of relationshipTables) {
    const collapsed = COLLAPSED.has(table.from) || COLLAPSED.has(table.to);
    kept.set(table.type, !collapsed || THROUGH_COLLAPSED.has(table.type) || table.type === "RESOLVES_TO" || table.type === "CALL_RESOLVES_TO" || table.type === "REQUESTS");
  }
  const buckets = new Map<string, Bucket>();
  await store.forEachRecord({
    node(label, id, properties) {
      if (COLLAPSED.has(label)) return;
      const list = nodesByLabel.get(label);
      if (list) list.push([id, properties]);
      else nodesByLabel.set(label, [[id, properties]]);
    },
    relationship(type, from, to, properties) {
      if (!kept.get(type)) return;
      let bucket = buckets.get(type);
      if (!bucket) buckets.set(type, (bucket = { from: [], to: [], props: [] }));
      bucket.from.push(from);
      bucket.to.push(to);
      bucket.props.push(properties);
    },
  });
  const nodes = new Map<string, IndexNode>();
  for (const label of nodeLabels) {
    for (const [id, props] of nodesByLabel.get(label) ?? []) nodes.set(id, { id, label, props: props as Record<string, unknown> });
    nodesByLabel.delete(label);
  }
  const rowsOf = (type: string): Bucket => buckets.get(type) ?? { from: [], to: [], props: [] };

  const pushTo = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  // Side tables first: what Imports and Calls resolve to, and the Calls that make requests.
  const resolvesTo = new Map<string, string[]>();
  const callTargets = new Map<string, string[]>();
  const resolves = rowsOf("RESOLVES_TO");
  for (let i = 0; i < resolves.from.length; i++) pushTo(resolvesTo, resolves.from[i]!, resolves.to[i]!);
  const callResolves = rowsOf("CALL_RESOLVES_TO");
  for (let i = 0; i < callResolves.from.length; i++) pushTo(callTargets, callResolves.from[i]!, callResolves.to[i]!);
  buckets.delete("RESOLVES_TO");
  buckets.delete("CALL_RESOLVES_TO");
  const requests = rowsOf("REQUESTS");
  const requestCalls = new Set<string>(requests.from);
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
    const rows = rowsOf(type);
    buckets.delete(type);
    const kind = kindOf(type);
    for (let i = 0; i < rows.from.length; i++) {
      const from = rows.from[i]!;
      const to = rows.to[i]!;
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
      const edge: IndexEdge = { from, to, type, kind, props: rows.props[i] as Record<string, unknown> };
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
  for (let i = 0; i < requests.from.length; i++) {
    const call = requests.from[i]!;
    const route = requests.to[i]!;
    if (!nodes.has(route)) continue;
    const callerFunction = (callerFunctions.get(call) ?? []).find((id) => nodes.get(id)?.label === "Function");
    const file = (callOwners.get(call) ?? []).map((owner) => fileOf.get(owner)).find((id) => id !== undefined && nodes.has(id));
    const origin = callerFunction ?? file;
    if (!origin) continue;
    add({ from: origin, to: route, type: "REQUESTS", kind: "requests", props: requests.props[i] as Record<string, unknown> }, requestEdges, requestSeen);
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
