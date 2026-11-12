import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { fileTypeFilter, optionalString, requiredString } from "../args.js";
import { createGlobMatcher } from "../../../core/scan/glob.js";
import { matchesFileOrDirectory } from "../agent-tools/graph.js";
import type { PageWindow } from "../paging.js";
import { byFileAndLine, type DeclarationKind, describeDeclaration, loadDeclarations, loadFiles } from "./model.js";

export const DECLARATION_KINDS: readonly DeclarationKind[] = ["function", "method", "class", "interface", "type", "enum", "variable"];

export type MatchType = "exact" | "exact-ignore-case" | "prefix" | "initials" | "substring" | "fuzzy";

// Match types rank in this order; within one, `score` orders the matches.
const TIER: Record<MatchType, number> = {
  exact: 6000,
  "exact-ignore-case": 5000,
  prefix: 4000,
  initials: 3000,
  substring: 2000,
  fuzzy: 1000,
};

// search_symbols: fuzzy declaration search. A query with a dot
// ("Service.find") is matched against Class.method names.
export async function searchSymbols(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const query = requiredString(args.query, "query").trim();
  if (query.length === 0) throw new Error("query must not be blank");
  const kind = optionalString(args.kind);
  if (kind && !DECLARATION_KINDS.includes(kind as DeclarationKind)) {
    throw new Error(`Unknown kind ${JSON.stringify(kind)}; expected one of ${DECLARATION_KINDS.join(", ")}`);
  }
  const file = optionalString(args.file);
  const types = fileTypeFilter(args);
  const files = types.sourceType || types.language ? await loadFiles(engine) : null;
  const typeMatches = (path: string) => {
    if (!files) return true;
    const info = files.get(path);
    return (!types.sourceType || info?.sourceType === types.sourceType) && (!types.language || info?.language === types.language);
  };

  // Files concentrate.json lists under `deprioritize` stay searchable but rank lower.
  const deprioritized = await deprioritizedMatcher(engine);
  const qualified = query.includes(".");
  const ranked = (await loadDeclarations(engine))
    .filter((declaration) => (!kind || declaration.kind === kind) && (!file || matchesFileOrDirectory(declaration.file, file)) && typeMatches(declaration.file))
    .flatMap((declaration) => {
      const name = qualified && declaration.className ? `${declaration.className}.${declaration.name}` : declaration.name;
      const match = matchName(name, query);
      if (!match) return [];
      const lowered = deprioritized(declaration.file);
      return [{ declaration, name, ...match, score: lowered ? match.score - DEPRIORITIZE_PENALTY : match.score, lowered }];
    })
    .sort((a, b) =>
      b.score - a.score
      || a.name.length - b.name.length
      || Number(b.declaration.isExported) - Number(a.declaration.isExported)
      || byFileAndLine(a.declaration, b.declaration));

  return {
    query: { query, kind: kind ?? null, file: file ?? null, ...types },
    total: ranked.length,
    symbols: window.take(ranked).map(({ declaration, score, match, lowered }) => ({
      ...describeDeclaration(declaration),
      isExported: declaration.isExported,
      match,
      score,
      ...(lowered ? { deprioritized: true } : {}),
    })),
  };
}

// A deprioritized file drops one and a half match tiers: an exact match there still beats a prefix match elsewhere.
const DEPRIORITIZE_PENALTY = 1500;

async function deprioritizedMatcher(engine: IQueryEngine): Promise<(file: string) => boolean> {
  const [repo] = await engine.query("MATCH (repo:Repo) RETURN repo.deprioritize AS deprioritize LIMIT 1") as Array<{ deprioritize?: unknown }>;
  if (typeof repo?.deprioritize !== "string") return () => false;
  const matchers = (JSON.parse(repo.deprioritize) as string[]).map(createGlobMatcher);
  return (file) => matchers.some((matcher) => matcher.matches(file));
}

// Scores `name` against `query`, or null when it does not match at all.
export function matchName(name: string, query: string): { match: MatchType; score: number } | null {
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const scored = (match: MatchType, bonus: number) => ({ match, score: TIER[match] + Math.max(0, Math.min(999, Math.round(bonus))) });

  if (name === query) return scored("exact", 999);
  if (lowerName === lowerQuery) return scored("exact-ignore-case", 999);
  // Closer to the query's length ranks higher.
  if (lowerName.startsWith(lowerQuery)) return scored("prefix", 999 - (name.length - query.length) * 10);
  if (lowerQuery.length >= 2) {
    const initials = words(name).map((word) => word[0]!.toLowerCase()).join("");
    if (initials.startsWith(lowerQuery)) return scored("initials", 999 - (initials.length - lowerQuery.length) * 50);
  }
  const at = lowerName.indexOf(lowerQuery);
  if (at >= 0) return scored("substring", 999 - at * 10 + (isBoundary(name, at) ? 300 : 0) - (name.length - query.length) * 5);
  const fuzzy = subsequenceScore(name, lowerName, lowerQuery);
  return fuzzy === null ? null : scored("fuzzy", fuzzy);
}

// Words of an identifier: camelCase humps, acronyms, digit runs, and parts
// split by _ - $ or dots.
export function words(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
}

function isBoundary(name: string, index: number): boolean {
  if (index === 0) return true;
  const previous = name[index - 1]!;
  const current = name[index]!;
  if (/[_\-$.\s]/.test(previous)) return true;
  if (/[A-Z]/.test(current) && /[a-z0-9]/.test(previous)) return true;
  return /\d/.test(current) !== /\d/.test(previous);
}

// Matches the query's letters in order (as fzf does): consecutive letters and
// letters at word starts score higher; gaps and a late first letter cost.
function subsequenceScore(name: string, lowerName: string, lowerQuery: string): number | null {
  let score = 0;
  let queryIndex = 0;
  let previous = -2;
  let first = -1;
  for (let index = 0; index < lowerName.length && queryIndex < lowerQuery.length; index++) {
    if (lowerName[index] !== lowerQuery[queryIndex]) continue;
    score += 10 + (index === previous + 1 ? 15 : 0) + (isBoundary(name, index) ? 20 : 0);
    if (first < 0) first = index;
    previous = index;
    queryIndex++;
  }
  if (queryIndex < lowerQuery.length) return null;
  const gaps = previous - first + 1 - lowerQuery.length;
  // At most 900 for every letter consecutive at word starts.
  return 500 + (score / (45 * lowerQuery.length)) * 400 - gaps * 15 - first * 5 - (name.length - lowerQuery.length) * 10;
}

