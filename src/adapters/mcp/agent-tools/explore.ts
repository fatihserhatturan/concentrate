import { readFile } from "node:fs/promises";
import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalInteger, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { exploreGraph, questionTerms, rankSymbols, selectByFile, selectBySymbol } from "../../../core/queries/explore.js";
import { loadSymbols, matchesFileOrDirectory, type SymbolInfo } from "../../../core/queries/graph.js";

// explore: one call for a narrow question. The identifiers of the question
// (or a symbol, or a file) select the declarations that fit best; the result
// has their source, the call paths between them and a short summary of what
// changing them reaches. It spends the output budget on source, so a
// follow-up call is rarely needed to read the code it names.
// Selection, call paths and impact live in core/queries/explore.ts; reading
// the source files stays here.

// Source of a symbol is cut to this many lines; the sources of all symbols
// together to this many characters (the rest are listed without source).
const DEFAULT_SOURCE_LINES = 40;
const SOURCE_BUDGET_CHARS = 12_000;

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
    selected = selectBySymbol(all, symbolName, file);
    terms = [symbolName];
  } else if (question) {
    terms = questionTerms(question);
    const scoped = file ? all.filter((symbol) => matchesFileOrDirectory(symbol.file, file)) : all;
    selected = rankSymbols(scoped, terms).map((entry) => entry.symbol);
  } else {
    selected = selectByFile(all, file!);
  }
  const total = selected.length;
  selected = selected.slice(0, count);

  const { counts, paths, impact } = await exploreGraph(engine, selected);

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
      ...(symbol.kind === "function" || symbol.kind === "method" ? counts.get(symbol.id) : {}),
      ...(withSource ? { source: text, ...(shownEnd < end ? { sourceTruncated: true } : {}) } : { source: null }),
    });
  }

  return {
    query: { question: question ?? null, symbol: symbolName ?? null, file: file ?? null, terms: question ? terms : undefined },
    total,
    symbols,
    paths,
    impact,
    note: total === 0
      ? "Nothing matched. Rephrase with identifier names from the code, or use search_symbols."
      : total > selected.length ? `${total - selected.length} more symbols matched; raise limit or narrow with file or symbol.` : undefined,
  };
}
