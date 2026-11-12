// The token arrives in the URL fragment, which is never sent to the server or logged.
function readToken(): string {
  const match = /token=([\w-]+)/.exec(location.hash);
  if (match) {
    sessionStorage.setItem("concentrate-token", match[1]);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem("concentrate-token") ?? "";
}

const token = readToken();
const headers = { "x-concentrate-token": token };

export type FsEntry = { name: string; path: string; isGitRepository: boolean; hasGraph: boolean };
export type FsListing = { path: string; parent: string | null; home: string; current: { isGitRepository: boolean; hasGraph: boolean }; entries: FsEntry[] };

export async function listDirectories(dir?: string): Promise<FsListing> {
  const response = await fetch(`/api/fs${dir ? `?path=${encodeURIComponent(dir)}` : ""}`, { headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

export type ScanOptions = { path: string; include: string[]; exclude: string[]; apiOrigins: string[]; cache: boolean };
export type ScanDone = { status: "ok" | "partial" | "failed"; nodes: number; relationships: number; report: any; database: string };

export async function scan(
  options: ScanOptions,
  onProgress: (current: number, total: number, file: string) => void,
): Promise<ScanDone> {
  const response = await fetch("/api/scan", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok || !response.body) throw new Error((await response.json()).error ?? response.statusText);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.type === "progress") onProgress(event.current, event.total, event.file);
      else if (event.type === "error") throw new Error(event.message);
      else if (event.type === "done") return event;
    }
  }
  throw new Error("The scan ended without a result");
}

// ---- graph API ----
let project = "";
export const setProject = (p: string) => { project = p; };
export const currentProject = () => project;

async function getJson<T>(endpoint: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const query = new URLSearchParams({ project });
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, value);
  const response = await fetch(`${endpoint}?${query}`, { headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

export type OverviewNode = { id: string; label: string; name: string; files: number; package: string | null; degree: number };
export type OverviewEdge = { from: string; to: string; count: number; byKind: Record<string, number> };
export type Overview = { level: string; prefix: string; nodes: OverviewNode[]; edges: OverviewEdge[]; truncated: boolean; isolatedHidden: number };
export type ViewNode = { id: string; label: string; name: string; file: string | null; line: number | null; package: string | null };
export type ViewEdge = { from: string; to: string; type: string; kind: string };
export type Neighbors = { nodes: ViewNode[]; edges: ViewEdge[]; truncated: boolean };
export type NodeDetail = {
  id: string; label: string; name: string; properties: Record<string, unknown>; file: string | null; line: number | null;
  outgoing: Record<string, Array<{ id: string; label: string; name: string }>>;
  incoming: Record<string, Array<{ id: string; label: string; name: string }>>;
};
export type SearchResult = ViewNode & { match: string };

export const graphSummary = () => getJson<any>("/api/graph/summary");
export const graphOverview = (level: string, prefix: string, types: string[]) =>
  getJson<Overview>("/api/graph/overview", { level, prefix, types: types.join(",") });
export const graphNeighbors = (id: string, types: string[], depth = 1) =>
  getJson<Neighbors>("/api/graph/neighbors", { id, types: types.join(","), depth: String(depth) });
export const graphNode = (id: string) => getJson<NodeDetail>("/api/graph/node", { id });
export const graphSource = (id: string) => getJson<{ file?: string; line?: number; endLine?: number; source: string | null; truncated?: boolean; note?: string }>("/api/graph/source", { id });
export const graphSearch = (q: string) => getJson<{ total: number; results: SearchResult[] }>("/api/search", { q });

export type ExportOptions = { format: string; scope: "graph" | "view"; types: string[]; prefix: string; focus?: string };
/** A download URL; the token travels in the query because a link cannot set headers. */
export function exportUrl(options: ExportOptions): string {
  const query = new URLSearchParams({ project, token, format: options.format, scope: options.scope });
  if (options.scope === "view") {
    query.set("types", options.types.join(","));
    if (options.focus) query.set("focus", options.focus);
    else if (options.prefix) query.set("prefix", options.prefix);
  }
  return `/api/export?${query}`;
}

export type PresetResult = { preset: string; nodes: ViewNode[]; edges: Array<ViewEdge & { highlight?: boolean }>; truncated: boolean; note: string };
export const graphPreset = (name: string) => getJson<PresetResult>("/api/graph/preset", { name });

export type QueryResult = { columns: string[]; rows: Array<Record<string, unknown>>; total: number; truncated: boolean };
export async function runQuery(query: string): Promise<QueryResult> {
  const response = await fetch("/api/query", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ project, query }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

export type ProjectInfo = {
  path: string; name: string; exists: boolean; isGitRepository: boolean; hasGraph: boolean;
  scannedAt: string | null; files: number | null; nodes: number | null; schemaVersion: number | null;
};
export async function projectInfo(path: string): Promise<ProjectInfo> {
  const response = await fetch(`/api/project?path=${encodeURIComponent(path)}`, { headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

// ---- views ----
export type Column = { key: string; label: string; kind?: "text" | "number" | "badge" | "code"; filter?: boolean };
export type EntityRow = { id: string } & Record<string, string | number | boolean | null>;
export type EntityKind = "files" | "routes" | "tables" | "components" | "env" | "entrypoints";
export type EntityTable = { kind: EntityKind; columns: Column[]; rows: EntityRow[]; summary: { by: string; groups: Array<{ label: string; count: number }> } };
export const graphCatalog = () => getJson<{ views: Record<EntityKind, number> }>("/api/graph/catalog");
export const graphEntities = (kind: EntityKind) => getJson<EntityTable>("/api/graph/entities", { kind });

export type Dashboard = {
  repo: { name: string; path: string }; schemaVersion: number | null; files: { total: number; tests: number };
  languages: Array<{ name: string; count: number }>;
  packages: Array<{ name: string; path: string; manager: string | null; files: number }>;
  kinds: Array<{ label: string; count: number; view: string | null }>;
  topFiles: Array<{ id: string; path: string; language: string; usedBy: number; uses: number; links: number }>;
};
export const graphDashboard = () => getJson<Dashboard>("/api/graph/dashboard");

export type Issues = {
  cycles: Array<{ size: number; typeOnly: boolean; files: Array<{ id: string | null; path: string }>; cycle: string[] }>;
  unused: Array<{ id: string | null; kind: string; name: string; className?: string; file: string; line: number | null; usedInFile: boolean }>;
  deadFunctions: Array<{ id: string | null; kind: string; name: string; file: string; line: number | null }>;
  note: string;
};
export const graphIssues = () => getJson<Issues>("/api/graph/issues");
