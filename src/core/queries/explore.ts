import type { IQueryEngine } from "../contracts/query-engine.js";
import { matchName, type MatchType } from "./match.js";
import { computeImpact, loadCallEdges, loadFunctions, matchesFileOrDirectory, type CallEdge, type SymbolInfo } from "./graph.js";

// explore, the graph half: which declarations a symbol name or a file selects,
// the call counts and call paths among the selected ones, and a short summary
// of what changing them reaches. Ranking by question terms and reading the
// source text stay in the MCP adapter.

export const EXPLORE_KINDS = new Set(["function", "method", "class", "interface"]);
const ACCEPTED = new Set<MatchType>(["exact", "exact-ignore-case", "prefix", "substring"]);
const MAX_PATHS = 8;
const MAX_PATH_DEPTH = 6;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "what", "which", "where", "when", "does", "how", "why", "who",
  "are", "was", "were", "has", "have", "can", "will", "should", "would", "could", "about", "all", "any", "show", "find", "get",
  "work", "works", "used", "use", "uses", "using", "code", "function", "functions", "method", "methods", "class", "classes",
  "file", "files", "call", "calls", "called", "caller", "callers", "flow", "path", "between", "reach", "reaches", "handle",
  "handles", "happens", "happen", "there", "their", "them", "then", "than", "not", "but", "its", "our", "your", "you", "does",
]);


export function questionTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const token of question.split(/[^\p{L}\p{N}_$.]+/u)) {
    const word = token.replace(/^\.+|\.+$/gu, "");
    if (word.length < 3 || STOPWORDS.has(word.toLowerCase())) continue;
    terms.add(word);
    // A dotted name also searches by its last part: Service.find -> find.
    const last = word.split(".").at(-1)!;
    if (last !== word && last.length >= 3 && !STOPWORDS.has(last.toLowerCase())) terms.add(last);
  }
  return [...terms];
}

type Ranked = { symbol: SymbolInfo; score: number; terms: string[] };

export function rankSymbols(symbols: readonly SymbolInfo[], terms: readonly string[]): Ranked[] {
  type Hit = { term: string; match: MatchType; score: number };
  const found: Array<{ symbol: SymbolInfo; hits: Hit[] }> = [];
  const frequency = new Map<string, number>();
  for (const symbol of symbols) {
    if (!EXPLORE_KINDS.has(symbol.kind)) continue;
    const qualified = symbol.className ? `${symbol.className}.${symbol.name}` : symbol.name;
    const hits: Hit[] = [];
    for (const term of terms) {
      const byName = matchName(term.includes(".") ? qualified : symbol.name, term);
      let hit: Hit | null = byName && ACCEPTED.has(byName.match) ? { term, ...byName } : null;
      // A match on the file's name counts a fifth: it lifts the file's declarations over unrelated ones, not over a name that fits.
      if (!hit) {
        const byFile = matchName(symbol.file.split("/").at(-1)!.replace(/\.[^.]+$/u, ""), term);
        if (byFile && ACCEPTED.has(byFile.match)) hit = { term, match: "substring", score: byFile.score / 5 };
      }
      if (!hit) continue;
      hits.push(hit);
      if (byName && ACCEPTED.has(byName.match)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
    if (hits.length > 0) found.push({ symbol, hits });
  }

  const ranked: Ranked[] = found.map(({ symbol, hits }) => {
    let score = 0;
    for (const hit of hits) {
      // A term most names contain ("command") says little; a rare one says a lot.
      const weight = 1 / (1 + Math.log(1 + (frequency.get(hit.term) ?? 1)));
      // A name the question spells out beats names that only contain its words.
      // The exact-name bonus shrinks with the term's frequency: `server` naming 375 structs is no answer to a question about the MCP server.
      const exactBonus = hit.match === "exact" || hit.match === "exact-ignore-case" ? 8000 * Math.min(1, weight * 1.7) : 0;
      score += (hit.score + hit.term.length * 20) * weight + exactBonus;
    }
    if (hits.length > 1) score += (hits.length - 1) * 4000;
    return { symbol, score, terms: hits.map((hit) => hit.term) };
  });
  return ranked.sort((a, b) => b.score - a.score || a.symbol.name.length - b.symbol.name.length || a.symbol.file.localeCompare(b.symbol.file) || (a.symbol.line ?? 0) - (b.symbol.line ?? 0));
}


/** Declarations named `symbolName` (`name` or `Class.member`), optionally within a file or directory. */
export function selectBySymbol(all: readonly SymbolInfo[], symbolName: string, file?: string): SymbolInfo[] {
  const dot = symbolName.lastIndexOf(".");
  const [className, member] = dot > 0 ? [symbolName.slice(0, dot), symbolName.slice(dot + 1)] : [null, symbolName];
  return all.filter((symbol) => EXPLORE_KINDS.has(symbol.kind) && symbol.name === member && (!className || symbol.className === className) && (!file || matchesFileOrDirectory(symbol.file, file)));
}

/** A file's declarations, the longest first (the ones worth reading). */
export function selectByFile(all: readonly SymbolInfo[], file: string): SymbolInfo[] {
  return all.filter((symbol) => EXPLORE_KINDS.has(symbol.kind) && symbol.kind !== "interface" && matchesFileOrDirectory(symbol.file, file))
    .sort((a, b) => ((b.endLine ?? b.line ?? 0) - (b.line ?? 0)) - ((a.endLine ?? a.line ?? 0) - (a.line ?? 0)));
}

export type ExploreGraph = {
  /** Resolved callers and callees per function id (functions and methods only). */
  counts: Map<string, { callers: number; callees: number }>;
  paths: Array<{ from: string; to: string; calls: number; path: string[] }>;
  impact: null | {
    callers: number;
    routes: string[];
    entrypoints: number;
    components: number;
    pages: number;
    tables: number;
    envVars: string[];
  };
};

export async function exploreGraph(engine: IQueryEngine, selected: readonly SymbolInfo[]): Promise<ExploreGraph> {
  const [functions, edges] = await Promise.all([loadFunctions(engine), loadCallEdges(engine)]);
  const callers = new Map<string, number>();
  const callees = new Map<string, number>();
  for (const edge of edges) {
    callers.set(edge.callee, (callers.get(edge.callee) ?? 0) + 1);
    callees.set(edge.caller, (callees.get(edge.caller) ?? 0) + 1);
  }
  const counts = new Map<string, { callers: number; callees: number }>();
  for (const symbol of selected) counts.set(symbol.id, { callers: callers.get(symbol.id) ?? 0, callees: callees.get(symbol.id) ?? 0 });

  const callable = selected.filter((symbol) => symbol.kind === "function" || symbol.kind === "method");
  const label = (id: string) => {
    const info = functions.get(id);
    return info ? `${info.className ? `${info.className}.` : ""}${info.name} (${info.file ?? "?"}:${info.line ?? "?"})` : id;
  };
  const paths = callPaths(edges, callable.map((symbol) => symbol.id)).slice(0, MAX_PATHS)
    .map((path) => ({ from: label(path[0]!), to: label(path.at(-1)!), calls: path.length - 1, path: path.map(label) }));

  const found = callable.length > 0 ? await computeImpact(engine, callable.map((symbol) => symbol.id), 3, 5, functions) : null;
  const routeName = (route: Record<string, unknown>) => `${String(route.method)} ${String(route.fullPath ?? route.path)}`;
  const impact = found && {
    callers: found.callers.length,
    routes: found.routes.slice(0, 5).map((route) => routeName(route as Record<string, unknown>)),
    entrypoints: found.entrypoints.length,
    components: found.components.length,
    pages: found.pages.length,
    tables: found.tables.length,
    envVars: found.envVars.slice(0, 5).map((env) => String((env as Record<string, unknown>).name)),
  };
  return { counts, paths, impact };
}

// Shortest call chains from each symbol to the others, over resolved calls
// (caller to callee), at most MAX_PATH_DEPTH calls long, shortest first.
export function callPaths(edges: readonly CallEdge[], ids: readonly string[]): string[][] {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.caller, [...next.get(edge.caller) ?? [], edge.callee]);
  const targets = new Set(ids);
  const found: string[][] = [];
  for (const from of ids) {
    const parent = new Map<string, string>([[from, from]]);
    let frontier = [from];
    for (let depth = 0; depth < MAX_PATH_DEPTH && frontier.length > 0; depth += 1) {
      const following: string[] = [];
      for (const id of frontier) {
        for (const callee of next.get(id) ?? []) {
          if (parent.has(callee)) continue;
          parent.set(callee, id);
          following.push(callee);
          if (targets.has(callee)) {
            const path = [callee];
            while (path[0] !== from) path.unshift(parent.get(path[0]!)!);
            found.push(path);
          }
        }
      }
      frontier = following;
    }
  }
  return found.sort((a, b) => a.length - b.length);
}
