import { readFile } from "node:fs/promises";
import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalInteger, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { matchName, type MatchType } from "../analysis-tools/search.js";
import { computeImpact, loadCallEdges, loadFunctions, loadSymbols, matchesFileOrDirectory, type CallEdge, type SymbolInfo } from "./graph.js";

// explore: one call for a narrow question. The identifiers of the question
// (or a symbol, or a file) select the declarations that fit best; the result
// has their source, the call paths between them and a short summary of what
// changing them reaches. It spends the output budget on source, so a
// follow-up call is rarely needed to read the code it names.

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "what", "which", "where", "when", "does", "how", "why", "who",
  "are", "was", "were", "has", "have", "can", "will", "should", "would", "could", "about", "all", "any", "show", "find", "get",
  "work", "works", "used", "use", "uses", "using", "code", "function", "functions", "method", "methods", "class", "classes",
  "file", "files", "call", "calls", "called", "caller", "callers", "flow", "path", "between", "reach", "reaches", "handle",
  "handles", "happens", "happen", "there", "their", "them", "then", "than", "not", "but", "its", "our", "your", "you", "does",
]);

// Source of a symbol is cut to this many lines; the sources of all symbols
// together to this many characters (the rest are listed without source).
const DEFAULT_SOURCE_LINES = 40;
const SOURCE_BUDGET_CHARS = 12_000;
const MAX_PATHS = 8;
const MAX_PATH_DEPTH = 6;
const KINDS = new Set(["function", "method", "class", "interface"]);
const ACCEPTED = new Set<MatchType>(["exact", "exact-ignore-case", "prefix", "substring"]);

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
    if (!KINDS.has(symbol.kind)) continue;
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
      score += (hit.score + hit.term.length * 20) * weight + (hit.match === "exact" || hit.match === "exact-ignore-case" ? 8000 : 0);
    }
    if (hits.length > 1) score += (hits.length - 1) * 4000;
    return { symbol, score, terms: hits.map((hit) => hit.term) };
  });
  return ranked.sort((a, b) => b.score - a.score || a.symbol.name.length - b.symbol.name.length || a.symbol.file.localeCompare(b.symbol.file) || (a.symbol.line ?? 0) - (b.symbol.line ?? 0));
}

export async function explore(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const question = optionalString(args.question);
  const symbolName = optionalString(args.symbol);
  const file = optionalString(args.file);
  if (!question && !symbolName && !file) throw new Error("explore needs a question, a symbol or a file argument");
  const count = optionalInteger(args.limit, 6, 1, 20);
  const maxLines = optionalInteger(args.maxLines, DEFAULT_SOURCE_LINES, 5, 400);

  const all = await loadSymbols(engine);
  let selected: SymbolInfo[];
  let terms: string[] = [];
  if (symbolName) {
    const dot = symbolName.lastIndexOf(".");
    const [className, member] = dot > 0 ? [symbolName.slice(0, dot), symbolName.slice(dot + 1)] : [null, symbolName];
    selected = all.filter((symbol) => KINDS.has(symbol.kind) && symbol.name === member && (!className || symbol.className === className) && (!file || matchesFileOrDirectory(symbol.file, file)));
    terms = [symbolName];
  } else if (question) {
    terms = questionTerms(question);
    const scoped = file ? all.filter((symbol) => matchesFileOrDirectory(symbol.file, file)) : all;
    selected = rankSymbols(scoped, terms).map((entry) => entry.symbol);
  } else {
    // A file alone: its declarations, the longest first (the ones worth reading).
    selected = all.filter((symbol) => KINDS.has(symbol.kind) && symbol.kind !== "interface" && matchesFileOrDirectory(symbol.file, file!))
      .sort((a, b) => ((b.endLine ?? b.line ?? 0) - (b.line ?? 0)) - ((a.endLine ?? a.line ?? 0) - (a.line ?? 0)));
  }
  const total = selected.length;
  selected = selected.slice(0, count);

  const [functions, edges] = await Promise.all([loadFunctions(engine), loadCallEdges(engine)]);
  const callers = new Map<string, number>();
  const callees = new Map<string, number>();
  for (const edge of edges) {
    callers.set(edge.callee, (callers.get(edge.callee) ?? 0) + 1);
    callees.set(edge.caller, (callees.get(edge.caller) ?? 0) + 1);
  }

  const contents = new Map<string, Promise<string[] | null>>();
  const linesOf = (symbol: SymbolInfo) => {
    let lines = contents.get(symbol.path);
    if (!lines) contents.set(symbol.path, lines = readFile(symbol.path, "utf8").then((text) => text.split(/\r?\n/u), () => null));
    return lines;
  };

  let sourceChars = 0;
  const symbols = [];
  for (const symbol of selected) {
    const start = symbol.line ?? 1;
    const end = symbol.endLine ?? start;
    const shownEnd = Math.min(end, start + maxLines - 1);
    const lines = await linesOf(symbol);
    const text = lines ? lines.slice(start - 1, shownEnd).join("\n") : null;
    const withSource = text !== null && sourceChars + text.length <= SOURCE_BUDGET_CHARS;
    if (withSource) sourceChars += text.length;
    symbols.push({
      kind: symbol.kind,
      name: symbol.name,
      className: symbol.className,
      file: symbol.file,
      line: start,
      endLine: end,
      ...(symbol.kind === "function" || symbol.kind === "method" ? { callers: callers.get(symbol.id) ?? 0, callees: callees.get(symbol.id) ?? 0 } : {}),
      ...(withSource ? { source: text, ...(shownEnd < end ? { sourceTruncated: true } : {}) } : { source: null }),
    });
  }

  const callable = selected.filter((symbol) => symbol.kind === "function" || symbol.kind === "method");
  const label = (id: string) => {
    const info = functions.get(id);
    return info ? `${info.className ? `${info.className}.` : ""}${info.name} (${info.file ?? "?"}:${info.line ?? "?"})` : id;
  };
  const paths = callPaths(edges, callable.map((symbol) => symbol.id)).slice(0, MAX_PATHS)
    .map((path) => ({ from: label(path[0]!), to: label(path.at(-1)!), calls: path.length - 1, path: path.map(label) }));

  const impact = callable.length > 0 ? await computeImpact(engine, callable.map((symbol) => symbol.id), 3, 5, functions) : null;
  const routeName = (route: Record<string, unknown>) => `${String(route.method)} ${String(route.fullPath ?? route.path)}`;
  const summary = impact && {
    callers: impact.callers.length,
    routes: impact.routes.slice(0, 5).map((route) => routeName(route as Record<string, unknown>)),
    entrypoints: impact.entrypoints.length,
    components: impact.components.length,
    pages: impact.pages.length,
    tables: impact.tables.length,
    envVars: impact.envVars.slice(0, 5).map((env) => String((env as Record<string, unknown>).name)),
  };

  return {
    query: { question: question ?? null, symbol: symbolName ?? null, file: file ?? null, terms: question ? terms : undefined },
    total,
    symbols,
    paths,
    impact: summary,
    note: total === 0
      ? "Nothing matched. Rephrase with identifier names from the code, or use search_symbols."
      : total > selected.length ? `${total - selected.length} more symbols matched; raise limit or narrow with file or symbol.` : undefined,
  };
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
