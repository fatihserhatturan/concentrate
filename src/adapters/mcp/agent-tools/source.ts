import { readFile } from "node:fs/promises";
import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalString, requiredString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { byFileAndLine, loadSymbols, matchesFile, matchesFileOrDirectory, type SymbolInfo, type SymbolKind } from "./graph.js";

const MAX_SOURCE_LINES = 400;
const SYMBOL_KINDS: readonly SymbolKind[] = ["function", "method", "class", "interface", "type", "enum", "variable"];

// get_symbol_source: the source text of a declaration, sliced from the file
// on disk with the line span recorded at scan time. "Class.method" selects a
// method of one class.
export async function getSymbolSource(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const name = requiredString(args.name, "name");
  const file = optionalString(args.file);
  const kind = optionalString(args.kind);
  if (kind && !SYMBOL_KINDS.includes(kind as SymbolKind)) {
    throw new Error(`Unknown kind ${JSON.stringify(kind)}; expected one of ${SYMBOL_KINDS.join(", ")}`);
  }

  const dot = name.lastIndexOf(".");
  const [className, member] = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [null, name];
  const symbols = (await loadSymbols(engine, { name: member }))
    .filter((symbol) => !className || (symbol.kind === "method" && symbol.className === className))
    .filter((symbol) => !file || matchesFileOrDirectory(symbol.file, file))
    .filter((symbol) => !kind || symbol.kind === kind);

  const contents = new Map<string, Promise<string[] | null>>();
  const linesOf = (symbol: SymbolInfo) => {
    let lines = contents.get(symbol.path);
    if (!lines) {
      lines = readFile(symbol.path, "utf8").then((text) => text.split(/\r?\n/), () => null);
      contents.set(symbol.path, lines);
    }
    return lines;
  };

  const matches = [];
  for (const symbol of window.take(symbols)) {
    const lines = await linesOf(symbol);
    const start = symbol.line ?? 1;
    const end = symbol.endLine ?? start;
    const shownEnd = Math.min(end, start + MAX_SOURCE_LINES - 1);
    matches.push({
      kind: symbol.kind,
      name: symbol.name,
      className: symbol.className,
      file: symbol.file,
      line: start,
      endLine: end,
      ...(lines
        ? { source: lines.slice(start - 1, shownEnd).join("\n"), ...(shownEnd < end ? { truncated: true } : {}) }
        : { source: null, error: "file could not be read" }),
    });
  }
  return {
    name,
    matches,
    note: matches.length > 0
      ? "Source is read from disk using line spans from the last scan; it may differ if the file changed since."
      : "No declaration matched. Use find_definitions for a substring search.",
  };
}

// get_file_outline: the declarations of one file from the graph, in line order.
export async function getFileOutline(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const file = requiredString(args.file, "file");
  const fileRows = (await engine.query("MATCH (file:File) RETURN file.relativePath AS file, file.language AS language, file.sourceType AS sourceType") as Array<{ file?: unknown; language?: unknown; sourceType?: unknown }>)
    .filter((row) => matchesFile(String(row.file), file));
  const files = fileRows.map((row) => String(row.file)).sort();
  if (files.length !== 1) {
    return files.length === 0
      ? { file, outline: null, note: "No scanned file matched." }
      : { file, outline: null, candidates: files.slice(0, 50), note: "Several files matched; pass a longer path." };
  }
  const [relativePath] = files as [string];

  const [symbols, fields, imports, entrypoints] = await Promise.all([
    loadSymbols(engine, { files }),
    engine.query(`
      MATCH (file:File)-[:DEFINES_CLASS]->(class:Class)-[:DEFINES_FIELD]->(field:Field)
      WHERE file.relativePath = $file
      RETURN class.name AS className, field.name AS name, field.typeName AS typeName, field.line AS line
    `, { file: relativePath }),
    engine.query(`
      MATCH (file:File)-[:IMPORTS]->(imp:Import)
      WHERE file.relativePath = $file
      RETURN imp.source AS source, imp.line AS line, imp.isTypeOnly AS isTypeOnly
    `, { file: relativePath }),
    engine.query(`
      MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entrypoint:EntryPoint)
      WHERE file.relativePath = $file
      RETURN entrypoint.kind AS kind, entrypoint.trigger AS trigger, entrypoint.handlerName AS handlerName,
        entrypoint.line AS line
    `, { file: relativePath }),
  ]) as [SymbolInfo[], Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>];

  const entry = ({ kind, name, line, endLine }: SymbolInfo) => ({ kind, name, line, ...(endLine !== null ? { endLine } : {}) });
  const outline: Array<Record<string, unknown>> = symbols
    .filter((symbol) => symbol.kind !== "method")
    .map((symbol) => symbol.kind !== "class" ? entry(symbol) : {
      ...entry(symbol),
      members: [
        ...symbols.filter((member) => member.kind === "method" && member.className === symbol.name).map(entry),
        ...fields.filter((field) => field.className === symbol.name).map(({ className: _class, ...field }) => ({ kind: "field", ...field })),
      ].sort(byFileAndLine),
    });
  // Methods whose class was not found in this file (e.g. object-literal methods).
  const classNames = new Set(symbols.filter((symbol) => symbol.kind === "class").map((symbol) => symbol.name));
  outline.push(...symbols.filter((symbol) => symbol.kind === "method" && !classNames.has(symbol.className ?? "")).map(entry));
  outline.push(...entrypoints.map((entrypoint) => ({ ...entrypoint, kind: `entrypoint:${String(entrypoint.kind)}` })));

  const row = fileRows.find((candidate) => String(candidate.file) === relativePath);
  return {
    file: relativePath,
    language: row?.language ?? null,
    sourceType: row?.sourceType ?? null,
    imports: imports.sort(byFileAndLine),
    outline: window.take(outline.sort(byFileAndLine)),
  };
}
