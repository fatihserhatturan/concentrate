import path from "node:path";
import type { IChangeSource } from "../contracts/change-source.js";
import type { IQueryEngine } from "../contracts/query-engine.js";
import { affectedTests, type AffectedTest } from "./affected.js";
import { computeImpact, loadSymbols, type SymbolInfo } from "./graph.js";

export type LineRange = { start: number; end: number };

export type ChangedFile = {
  file: string;
  // "all", "12" or "12-20".
  ranges: string[];
  symbols: Array<Pick<SymbolInfo, "kind" | "name" | "className" | "line" | "endLine">>;
};

export type DetectChangesOptions = {
  // Directory the project was scanned from (the Repo node's path).
  scanPath: string;
  base: string;
  maxDepth: number;
  // Caps the impact lists.
  limit: number;
};

export type DetectChangesResult = {
  base: string;
  changedFiles: ChangedFile[];
  affectedTests: AffectedTest[];
  unscannedFiles: string[];
  impact: Awaited<ReturnType<typeof computeImpact>> | null;
};

// Diff the working tree against `base`, map the changed lines onto the
// graph's declarations, and compute the impact of the changed functions.
// Untracked files count as changed from top to bottom.
export async function detectChanges(engine: IQueryEngine, source: IChangeSource, options: DetectChangesOptions): Promise<DetectChangesResult> {
  const { base, maxDepth, limit } = options;
  const { scanRoot, repoRoot, diff, untracked } = await source.changes({ scanPath: options.scanPath, base });

  // Changed ranges keyed by scan-relative path; files outside the scan root are dropped.
  const changes = new Map<string, LineRange[]>();
  const toScanPath = (repoPath: string) => {
    const relative = path.relative(scanRoot, path.join(repoRoot, repoPath));
    return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative.split(path.sep).join("/");
  };
  for (const [repoPath, ranges] of parseDiff(diff)) {
    const file = toScanPath(repoPath);
    if (file) changes.set(file, ranges);
  }
  for (const repoPath of untracked) {
    const file = toScanPath(repoPath);
    if (file) changes.set(file, [{ start: 1, end: Number.POSITIVE_INFINITY }]);
  }

  const files = [...changes.keys()].sort();
  const symbols = await loadSymbols(engine, { files });
  const symbolsByFile = new Map<string, SymbolInfo[]>();
  for (const symbol of symbols) symbolsByFile.set(symbol.file, [...symbolsByFile.get(symbol.file) ?? [], symbol]);
  const changedSymbols: SymbolInfo[] = [];
  const changedFiles: ChangedFile[] = [];
  const unscannedFiles: string[] = [];
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
  // Test files that reach the changed files through imports and calls.
  const tests = changedFiles.length > 0
    ? (await affectedTests(engine, changedFiles.map((entry) => entry.file))).tests
    : [];
  return { base, changedFiles, affectedTests: tests, unscannedFiles, impact };
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
