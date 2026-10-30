import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalInteger, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { computeImpact, loadFunctions, loadSymbols, matchesFile, type SymbolInfo } from "./graph.js";

const run = promisify(execFile);

// impact_of: a symbol name selects the functions with that name plus the
// methods of a class with that name; a file selects every function in it.
// Both together narrow the symbol to that file.
export async function impactOf(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const symbol = optionalString(args.symbol);
  const file = optionalString(args.file);
  if (!symbol && !file) throw new Error("impact_of needs a symbol or a file argument");
  const maxDepth = optionalInteger(args.maxDepth, 5, 1, 20);

  const functions = await loadFunctions(engine);
  const seedIds = [...functions.values()]
    .filter((fn) => !symbol || fn.name === symbol || fn.className === symbol)
    .filter((fn) => !file || matchesFile(fn.file, file))
    .map((fn) => fn.id);
  if (seedIds.length === 0) {
    return {
      symbol: symbol ?? null,
      file: file ?? null,
      seeds: [],
      note: "No function, method or class matched. Use find_definitions to look the name up; for routes use route_details.",
    };
  }
  return { symbol: symbol ?? null, file: file ?? null, maxDepth, ...await computeImpact(engine, seedIds, maxDepth, window.limit, functions, window) };
}

// Revisions are passed to git as a single argv entry, never through a shell;
// the pattern still rejects option-like and odd values.
const BASE_PATTERN = /^[\w./~^@{}-]+$/;

type LineRange = { start: number; end: number };

// detect_changes: diff the working tree against `base` (default HEAD), map
// the changed lines onto the graph's declarations, and compute the impact of
// the changed functions. Untracked files count as changed from top to bottom.
export async function detectChanges(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const base = optionalString(args.base) ?? "HEAD";
  if (!BASE_PATTERN.test(base) || base.startsWith("-")) {
    throw new Error(`Invalid base revision: ${JSON.stringify(base)}`);
  }
  const maxDepth = optionalInteger(args.maxDepth, 5, 1, 20);
  const { limit } = window;

  const [repo] = await engine.query("MATCH (repo:Repo) RETURN repo.path AS path LIMIT 1") as Array<{ path?: unknown }>;
  if (typeof repo?.path !== "string") throw new Error("The graph has no Repo node; scan the project first");
  const scanRoot = await realpath(repo.path);

  const git = async (gitArgs: string[]) =>
    (await run("git", ["-c", "core.quotePath=false", ...gitArgs], { cwd: scanRoot, maxBuffer: 64 * 1024 * 1024 })).stdout;
  let gitRoot: string;
  try {
    gitRoot = await realpath((await git(["rev-parse", "--show-toplevel"])).trim());
  } catch {
    throw new Error(`${scanRoot} is not inside a git work tree`);
  }
  const [diff, untracked] = await Promise.all([
    git(["-C", gitRoot, "diff", "--unified=0", "--no-color", "--no-ext-diff", base, "--"]).catch((error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`git diff against ${base} failed${stderr ? `: ${stderr}` : ""}`);
    }),
    git(["-C", gitRoot, "ls-files", "--others", "--exclude-standard", "-z"]),
  ]);

  // Changed ranges keyed by scan-relative path; files outside the scan root are dropped.
  const changes = new Map<string, LineRange[]>();
  const toScanPath = (gitPath: string) => {
    const relative = path.relative(scanRoot, path.join(gitRoot, gitPath));
    return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative.split(path.sep).join("/");
  };
  for (const [gitPath, ranges] of parseDiff(diff)) {
    const file = toScanPath(gitPath);
    if (file) changes.set(file, ranges);
  }
  for (const gitPath of untracked.split("\0").filter(Boolean)) {
    const file = toScanPath(gitPath);
    if (file) changes.set(file, [{ start: 1, end: Number.POSITIVE_INFINITY }]);
  }

  const files = [...changes.keys()].sort();
  const symbols = await loadSymbols(engine, { files });
  const symbolsByFile = new Map<string, SymbolInfo[]>();
  for (const symbol of symbols) symbolsByFile.set(symbol.file, [...symbolsByFile.get(symbol.file) ?? [], symbol]);
  const changedSymbols: SymbolInfo[] = [];
  const changedFiles = [];
  const unscannedFiles = [];
  const scanned = new Set((await engine.query(
    "MATCH (file:File) WHERE file.relativePath IN $files RETURN file.relativePath AS file",
    { files },
  ) as Array<{ file?: unknown }>).map((row) => row.file));

  for (const file of files) {
    if (!scanned.has(file)) {
      unscannedFiles.push(file);
      continue;
    }
    const ranges = changes.get(file)!;
    const touched = (symbolsByFile.get(file) ?? []).filter((symbol) => overlaps(symbol, ranges));
    changedSymbols.push(...touched);
    changedFiles.push({
      file,
      ranges: ranges.map(({ start, end }) => (end === Number.POSITIVE_INFINITY ? "all" : start === end ? `${start}` : `${start}-${end}`)),
      symbols: touched.map(({ kind, name, className, line, endLine }) => ({ kind, name, className, line, endLine })),
    });
  }

  const changedFunctionIds = changedSymbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "method").map((symbol) => symbol.id);
  const impact = changedFunctionIds.length > 0 ? await computeImpact(engine, changedFunctionIds, maxDepth, limit) : null;
  return {
    base,
    changedFiles: window.take(changedFiles),
    unscannedFiles: unscannedFiles.slice(0, limit),
    ...(unscannedFiles.length > 0
      ? { note: "Some changed files are not in the graph (new, unsupported or excluded). Rescan, or keep `concentrate watch` running, to include new files." }
      : {}),
    impact: impact && { callers: impact.callers, moduleCallers: impact.moduleCallers, routes: impact.routes, entrypoints: impact.entrypoints, components: impact.components, dataAccess: impact.dataAccess, envVars: impact.envVars, config: impact.config },
  };
}

function overlaps(symbol: SymbolInfo, ranges: readonly LineRange[]): boolean {
  if (symbol.line === null) return false;
  const end = symbol.endLine ?? symbol.line;
  return ranges.some((range) => range.start <= end && symbol.line! <= range.end);
}

// New-side line ranges per file from `git diff --unified=0`. A hunk that only
// deletes lines is recorded as the line it was deleted after; a deleted file
// counts as changed throughout, so its old declarations still show up.
export function parseDiff(diff: string): Map<string, LineRange[]> {
  const files = new Map<string, LineRange[]>();
  let oldPath: string | null = null;
  let current: LineRange[] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = line === "--- /dev/null" ? null : line.slice(6);
    } else if (line.startsWith("+++ ")) {
      const newPath = line === "+++ /dev/null" ? null : line.slice(6);
      const file = newPath ?? oldPath;
      current = file ? files.get(file) ?? [] : null;
      if (file && current) files.set(file, current);
      if (!newPath && current) current.push({ start: 1, end: Number.POSITIVE_INFINITY });
      if (!newPath) current = null;
    } else if (current && line.startsWith("@@")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      current.push(count === 0 ? { start: Math.max(start, 1), end: Math.max(start, 1) } : { start, end: start + count - 1 });
    }
  }
  return files;
}
