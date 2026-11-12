import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { louvain } from "../../../core/graph/louvain.js";
import { CODE_LANGUAGES, type SupportedLanguage } from "../../../core/scan/language.js";
import { loadCallEdges, loadFunctions } from "../agent-tools/graph.js";
import { loadImports } from "./model.js";

type Row = Record<string, unknown>;

// The file graph behind hubs and subsystems: code files other than tests,
// connected by resolved imports and by calls from one file into another.
export type FileGraph = {
  files: string[];
  // Undirected weight between two files (imports plus calls), key `a\0b` with a < b.
  weights: Map<string, number>;
  importedBy: Map<string, Set<string>>;
  imports: Map<string, Set<string>>;
  calledFrom: Map<string, Set<string>>;
  // Distinct caller functions of each function, test callers left out.
  callers: Map<string, number>;
  functions: Awaited<ReturnType<typeof loadFunctions>>;
};

export async function loadFileGraph(engine: IQueryEngine): Promise<FileGraph> {
  const [fileRows, imports, functions, calls] = await Promise.all([
    engine.query("MATCH (file:File) RETURN file.relativePath AS file, file.language AS language, file.isTest AS isTest") as Promise<Row[]>,
    loadImports(engine),
    loadFunctions(engine),
    loadCallEdges(engine),
  ]);
  const files = fileRows
    .filter((row) => row.isTest !== true && (typeof row.language !== "string" || CODE_LANGUAGES.has(row.language as SupportedLanguage)))
    .map((row) => String(row.file))
    .sort();
  const included = new Set(files);

  const weights = new Map<string, number>();
  const importedBy = new Map<string, Set<string>>();
  const importsOf = new Map<string, Set<string>>();
  const calledFrom = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  const link = (from: string, to: string) => {
    const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  };
  for (const item of imports) {
    if (!item.target || item.target === item.file || !included.has(item.file) || !included.has(item.target)) continue;
    link(item.file, item.target);
    add(importedBy, item.target, item.file);
    add(importsOf, item.file, item.target);
  }
  const callers = new Map<string, number>();
  for (const edge of calls) {
    const from = functions.get(edge.caller)?.file;
    const to = functions.get(edge.callee)?.file;
    if (!from || !to || !included.has(from)) continue;
    callers.set(edge.callee, (callers.get(edge.callee) ?? 0) + 1);
    if (from === to || !included.has(to)) continue;
    link(from, to);
    add(calledFrom, to, from);
  }
  return { files, weights, importedBy, imports: importsOf, calledFrom, callers, functions };
}

const neighbors = (graph: FileGraph, file: string) =>
  new Set([...graph.importedBy.get(file) ?? [], ...graph.imports.get(file) ?? [], ...graph.calledFrom.get(file) ?? []]);

// The most connected files (distinct files they import, are imported by, or
// are called from) and the most called functions.
export function topHubs(graph: FileGraph, count: number) {
  const files = graph.files
    .map((file) => ({
      file,
      connections: neighbors(graph, file).size,
      importedBy: graph.importedBy.get(file)?.size ?? 0,
      imports: graph.imports.get(file)?.size ?? 0,
      calledFrom: graph.calledFrom.get(file)?.size ?? 0,
    }))
    .filter((entry) => entry.connections > 0)
    .sort((a, b) => b.connections - a.connections || a.file.localeCompare(b.file))
    .slice(0, count);
  const included = new Set(graph.files);
  const symbols = [...graph.callers]
    .flatMap(([id, callers]) => {
      const info = graph.functions.get(id);
      return info?.file && included.has(info.file) ? [{ name: info.name, className: info.className, file: info.file, line: info.line, callers }] : [];
    })
    .sort((a, b) => b.callers - a.callers || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, count);
  return { files, symbols };
}

export type Subsystem = {
  name: string;
  files: string[];
  internalEdges: number;
  externalEdges: number;
  topFiles: string[];
};

// Clusters of files by edge density (Louvain). A subsystem is named by the
// directory its files share, else by its best-connected file's directory;
// files with no edges belong to none.
export function subsystems(graph: FileGraph): Subsystem[] {
  const connected = graph.files.filter((file) => neighbors(graph, file).size > 0);
  const index = new Map(connected.map((file, at) => [file, at]));
  const edges: Array<[number, number, number]> = [];
  for (const [key, weight] of graph.weights) {
    const [a, b] = key.split("\0") as [string, string];
    if (index.has(a) && index.has(b)) edges.push([index.get(a)!, index.get(b)!, weight]);
  }
  const membership = louvain(connected.length, edges);

  const clusters = new Map<number, string[]>();
  connected.forEach((file, at) => clusters.set(membership[at]!, [...clusters.get(membership[at]!) ?? [], file]));
  const clusterOf = new Map<string, number>();
  for (const [id, members] of clusters) for (const file of members) clusterOf.set(file, id);

  const stats = new Map<number, { internal: number; external: number }>();
  for (const [key, weight] of graph.weights) {
    const [a, b] = key.split("\0") as [string, string];
    const ca = clusterOf.get(a);
    const cb = clusterOf.get(b);
    if (ca === undefined || cb === undefined) continue;
    const entry = (id: number) => stats.get(id) ?? stats.set(id, { internal: 0, external: 0 }).get(id)!;
    if (ca === cb) entry(ca).internal += weight;
    else {
      entry(ca).external += weight;
      entry(cb).external += weight;
    }
  }

  const used = new Map<string, number>();
  return [...clusters.entries()]
    .map(([id, members]) => {
      const topFiles = [...members].sort((a, b) => neighbors(graph, b).size - neighbors(graph, a).size || a.localeCompare(b)).slice(0, 3);
      let name = commonDirectory(members) || commonDirectory(topFiles) || (topFiles[0]!.split("/").slice(0, -1).join("/") || ".");
      // Two clusters of one directory tree: the second is named by where its best files are.
      if (used.has(name)) {
        const byTop = commonDirectory(topFiles) || topFiles[0]!.split("/").slice(0, -1).join("/") || ".";
        if (!used.has(byTop)) name = byTop;
      }
      const seen = used.get(name) ?? 0;
      used.set(name, seen + 1);
      if (seen > 0) name = `${name}#${seen + 1}`;
      return { name, files: members.sort(), internalEdges: stats.get(id)?.internal ?? 0, externalEdges: stats.get(id)?.external ?? 0, topFiles };
    })
    .filter((subsystem) => subsystem.files.length > 1)
    .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));
}

function commonDirectory(files: readonly string[]): string {
  const parts = files.map((file) => file.split("/").slice(0, -1));
  const first = parts[0] ?? [];
  let length = first.length;
  for (const other of parts) {
    let at = 0;
    while (at < length && other[at] === first[at]) at += 1;
    length = at;
  }
  return first.slice(0, length).join("/");
}
