import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { fileTypeFilter, optionalString, requiredString } from "../args.js";
import { createGlobMatcher } from "../../../core/scan/glob.js";
import { matchesFileOrDirectory } from "../../../core/queries/graph.js";
import { matchName } from "../../../core/queries/match.js";
import type { PageWindow } from "../paging.js";
import { byFileAndLine, type DeclarationKind, describeDeclaration, loadDeclarations, loadFiles } from "../../../core/queries/model.js";

export const DECLARATION_KINDS: readonly DeclarationKind[] = ["function", "method", "class", "interface", "type", "enum", "variable"];

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
