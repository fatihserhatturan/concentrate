import path from "node:path";
import type { IQueryEngine } from "../contracts/query-engine.js";
import type { ISourceReader } from "../contracts/source-reader.js";
import { loadFunctions, matchesFileOrDirectory } from "./graph.js";
import { type Declaration, describeDeclaration, ExportIndex, type FileInfo, loadDeclarations, loadFiles, loadImports } from "./model.js";

type Row = Record<string, unknown>;

// Why a file's exports are not judged: its whole export surface is public
// (a package entry point) or may be used without naming the export
// (namespace, dynamic or default imports, `export * as`).
type SurfaceReason = "packageEntry" | "wholeFileImported";

const LANGUAGES = new Set(["typescript", "javascript", "go", "rust", "python", "c", "cpp"]);
const MAX_DEAD_FUNCTIONS = 100;

export type FindUnusedExportsOptions = {
  /** File or directory path, or a path suffix, to check. */
  file?: string;
  /** Also check test and fixture files. */
  includeTests?: boolean;
};

export type UnusedExport = {
  id: string;
  kind: string;
  name: string;
  className?: string;
  file: string;
  line: number | null;
  /** The export is only used inside its own file. */
  usedInFile: boolean;
};

export type DeadFunction = { id: string; kind: string; name: string; className?: string; file: string; line: number | null };

export type UnusedExportsResult = {
  query: { file: string | null; includeTests: boolean };
  /** Every unused export, ordered like the declarations. */
  unusedExports: UnusedExport[];
  deadFunctions: DeadFunction[];
  skipped: Record<string, number>;
};

// find_unused_exports: exported declarations nothing in another file uses,
// plus file-level functions nothing uses at all. Both are candidates: uses
// the graph cannot see (string-based lookups, framework conventions,
// consumers outside the repository) are not counted.
export async function findUnusedExports(engine: IQueryEngine, reader: ISourceReader, options: FindUnusedExportsOptions = {}): Promise<UnusedExportsResult> {
  const file = options.file;
  const includeTests = options.includeTests ?? false;

  const [declarations, imports, files, packages, functions, links] = await Promise.all([
    loadDeclarations(engine),
    loadImports(engine),
    loadFiles(engine),
    engine.query("MATCH (package:Package) RETURN package.path AS path, package.relativePath AS relativePath") as Promise<Row[]>,
    loadFunctions(engine),
    loadLinks(engine),
  ]);
  const index = new ExportIndex(declarations, imports);
  const declarationsById = new Map(declarations.map((declaration) => [declaration.id, declaration]));

  // Files whose exports are not judged, through export * chains too.
  const surfaces = new Map<string, SurfaceReason>();
  const used = new Set<string>();
  const markSurface = (start: string, reason: SurfaceReason) => {
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (surfaces.has(current)) continue;
      surfaces.set(current, reason);
      for (const name of index.reExportedNames(current)) {
        const resolution = index.resolve(current, name);
        for (const declaration of resolution.declarations) used.add(declaration.id);
        queue.push(...resolution.namespaces);
      }
      queue.push(...index.wildcardTargets(current));
    }
  };

  // Without a package manifest the scan root counts as one package.
  const roots = packages.length > 0 ? packages : links.rootPath ? [{ path: links.rootPath, relativePath: "" }] : [];
  for (const entry of await packageEntries(reader, roots, files)) markSurface(entry, "packageEntry");
  for (const edge of imports) {
    if (!edge.target || edge.isReExport) continue;
    // `from m import *` takes every public name of `m` (or its `__all__`).
    if (edge.isWildcard && isPython(edge.file)) {
      markSurface(edge.target, "wholeFileImported");
      continue;
    }
    if (edge.bindings.length === 0) {
      if (edge.isDynamic) markSurface(edge.target, "wholeFileImported");
      continue;
    }
    for (const binding of edge.bindings) {
      if (binding.kind === "namespace" || (edge.isCjs && binding.imported === "default")) {
        markSurface(edge.target, "wholeFileImported");
        continue;
      }
      const resolution = index.resolve(edge.target, binding.imported);
      // A name that resolves to nothing (usually a default export) could be any of them.
      if (resolution.declarations.length === 0 && resolution.namespaces.length === 0) markSurface(edge.target, "wholeFileImported");
      for (const declaration of resolution.declarations) {
        if (declaration.file !== edge.file) used.add(declaration.id);
      }
      for (const namespace of resolution.namespaces) markSurface(namespace, "wholeFileImported");
    }
  }

  // Uses through calls, callbacks and class relations from other files (for
  // Go, other packages: its exports are what a package offers others).
  const fileOf = (id: string) => declarationsById.get(id)?.file ?? functions.get(id)?.file ?? null;
  // C and C++: `foo.h` and `foo.cpp` are one unit (a header's names are used by its source).
  const scopeOf = (file: string) => (isGo(file) ? path.posix.dirname(file) : isRust(file) ? (files.get(file)?.rustCrate ?? file) : isCpp(file) ? file.replace(/\.[^./]+$/u, "") : file);
  const calledAnywhere = new Set<string>();
  for (const link of links.uses) {
    calledAnywhere.add(link.target);
    const from = link.fromFile ?? (link.from ? fileOf(link.from) : null);
    const target = fileOf(link.target);
    if (from && target && scopeOf(from) !== scopeOf(target)) used.add(link.target);
  }

  const inScope = (declaration: Declaration) => {
    const info = files.get(declaration.file);
    return info !== undefined && LANGUAGES.has(info.language ?? "") && (!file || matchesFileOrDirectory(declaration.file, file));
  };
  const skipped: Record<string, number> = { packageEntry: 0, wholeFileImported: 0, defaultExports: 0, tests: 0, generated: 0, handlers: 0, goMain: 0, rustBinary: 0, pythonEntry: 0 };
  // Go names the graph has no edges for (types, variables, functions used as
  // values) count as used when another package's Go file mentions them.
  const goMentions = await goIdentifierIndex(reader, links.rootPath, files, declarations.some((declaration) => isGo(declaration.file)));
  // Rust: identifier counts per crate, for items the graph has no edges for
  // (types, consts, traits, enums).
  const rustMentions = await identifierIndex(reader, links.rootPath, files, declarations.some((declaration) => isRust(declaration.file)), isRust, scopeOf);
  // C and C++: identifier counts per unit; a function counts only where it
  // is written in a source file (a prototype in a header is not a use).
  const cppMentions = await cppIdentifierIndexes(reader, links.rootPath, files, declarations.some((declaration) => isCpp(declaration.file)), scopeOf);
  const skipReason = (declaration: Declaration, info: FileInfo): string | null => {
    // A binary crate (main.rs, src/bin, examples, tests, benches) has no dependents.
    if (isRust(declaration.file) && isRustBinaryCrate(info.rustCrate)) return "rustBinary";
    if (!includeTests && (info.isTest || info.isFixture)) return "tests";
    // Nothing imports a Go main package; init and main run without a caller.
    if (isGo(declaration.file) && (info.packageName === "main" || declaration.name === "init")) return "goMain";
    // Python files that tools run or load by name, not by import.
    if (isPython(declaration.file) && /(?:^|\/)(?:__main__|setup|manage|wsgi|asgi|conftest)\.py$/u.test(declaration.file)) return "pythonEntry";
    if (info.isGenerated) return "generated";
    if (links.handlers.has(declaration.id)) return "handlers";
    // Default exports are what tools and frameworks load by convention (configs, pages).
    if (declaration.name === "default") return "defaultExports";
    return surfaces.get(declaration.file) ?? null;
  };

  const unused: UnusedExport[] = [];
  for (const declaration of declarations) {
    if (!declaration.isExported || declaration.kind === "method" || used.has(declaration.id) || !inScope(declaration)) continue;
    if (isGo(declaration.file) && mentionedOutside(goMentions, declaration.name, path.posix.dirname(declaration.file))) continue;
    // Rust: only `pub` leaves the crate; test code is no API.
    if (isRust(declaration.file)) {
      if (declaration.visibility !== "pub" || declaration.testKind) continue;
      if (mentionedOutside(rustMentions, declaration.name, scopeOf(declaration.file))) continue;
    }
    if (isCpp(declaration.file)) {
      if (declaration.testKind) continue;
      if (mentionedOutside(declaration.kind === "function" ? cppMentions.sources : cppMentions.all, declaration.name, scopeOf(declaration.file))) continue;
    }
    const reason = skipReason(declaration, files.get(declaration.file)!);
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    unused.push({ id: declaration.id, ...describeDeclaration(declaration), usedInFile: calledAnywhere.has(declaration.id) });
  }

  // File-level functions that are not exported, called, passed or handlers,
  // and whose name appears nowhere else in their file.
  const exportedNames = new Set(declarations.filter((declaration) => declaration.isExported).map((declaration) => `${declaration.file}\0${declaration.name}`));
  const deadCandidates = declarations.filter((declaration) =>
    declaration.kind === "function"
    && !declaration.isExported
    && /^[A-Za-z_$][\w$]*$/.test(declaration.name)
    && !exportedNames.has(`${declaration.file}\0${declaration.name}`)
    && !calledAnywhere.has(declaration.id)
    && !links.handlers.has(declaration.id)
    && !declaration.testKind
    && inScope(declaration)
    && skipReason(declaration, files.get(declaration.file)!) !== "tests");
  const deadFunctions: DeadFunction[] = [];
  const sources = new Map<string, Promise<string | undefined>>();
  const rootPath = links.rootPath;
  for (const declaration of deadCandidates) {
    if (deadFunctions.length >= MAX_DEAD_FUNCTIONS) break;
    // A Go function is visible in every file of its package.
    if (isGo(declaration.file)) {
      if (declaration.name !== "init" && declaration.name !== "main" && (goMentions.get(declaration.name)?.get(path.posix.dirname(declaration.file)) ?? 0) <= 1) {
        deadFunctions.push({ id: declaration.id, ...describeDeclaration(declaration) });
      }
      continue;
    }
    let text = sources.get(declaration.file);
    if (!text) sources.set(declaration.file, text = rootPath ? reader.readFile(path.join(rootPath, declaration.file)) : Promise.resolve(undefined));
    const source = await text;
    if (source === undefined) continue;
    const mentions = source.match(new RegExp(`(?<![\\w$.])${declaration.name.replace(/\$/g, "\\$")}(?![\\w$])`, "g"))?.length ?? 0;
    if (mentions <= 1) deadFunctions.push({ id: declaration.id, ...describeDeclaration(declaration) });
  }

  return {
    query: { file: file ?? null, includeTests },
    unusedExports: unused,
    deadFunctions,
    skipped,
  };
}

function isGo(file: string): boolean {
  return file.endsWith(".go");
}

function isPython(file: string): boolean {
  return file.endsWith(".py");
}

function isRust(file: string): boolean {
  return file.endsWith(".rs");
}

function isCpp(file: string): boolean {
  return /\.(?:c|h|cc|cpp|cxx|hpp|hh|hxx|ipp|inl)$/u.test(file);
}

const CPP_HEADER = /\.(?:h|hpp|hh|hxx|ipp|inl)$/u;

async function cppIdentifierIndexes(
  reader: ISourceReader,
  rootPath: string | null,
  files: ReadonlyMap<string, FileInfo>,
  needed: boolean,
  scopeOf: (file: string) => string,
): Promise<{ all: Map<string, Map<string, number>>; sources: Map<string, Map<string, number>> }> {
  const all = new Map<string, Map<string, number>>();
  const sources = new Map<string, Map<string, number>>();
  if (!needed || !rootPath) return { all, sources };
  for (const file of files.keys()) {
    if (!isCpp(file)) continue;
    const text = await reader.readFile(path.join(rootPath, file));
    if (text === undefined) continue;
    const scope = scopeOf(file);
    for (const name of text.match(/[A-Za-z_]\w*/gu) ?? []) {
      for (const index of CPP_HEADER.test(file) ? [all] : [all, sources]) {
        let byScope = index.get(name);
        if (!byScope) index.set(name, byScope = new Map());
        byScope.set(scope, (byScope.get(scope) ?? 0) + 1);
      }
    }
  }
  return { all, sources };
}

function isRustBinaryCrate(crateRoot: string | null | undefined): boolean {
  return crateRoot !== null && crateRoot !== undefined
    && /(^|\/)(main\.rs|build\.rs)$|(^|\/)(src\/bin|examples|tests|benches)\//u.test(crateRoot);
}

// Identifier occurrences in the scan's files of one language: name -> scope -> count.
async function identifierIndex(
  reader: ISourceReader,
  rootPath: string | null,
  files: ReadonlyMap<string, FileInfo>,
  needed: boolean,
  matches: (file: string) => boolean,
  scopeOf: (file: string) => string,
): Promise<Map<string, Map<string, number>>> {
  const index = new Map<string, Map<string, number>>();
  if (!needed || !rootPath) return index;
  for (const file of files.keys()) {
    if (!matches(file)) continue;
    const source = await reader.readFile(path.join(rootPath, file));
    if (source === undefined) continue;
    const scope = scopeOf(file);
    for (const name of source.match(/[A-Za-z_]\w*/gu) ?? []) {
      let byScope = index.get(name);
      if (!byScope) index.set(name, byScope = new Map());
      byScope.set(scope, (byScope.get(scope) ?? 0) + 1);
    }
  }
  return index;
}

// Identifier occurrences in the scan's Go files: name -> directory -> count.
async function goIdentifierIndex(reader: ISourceReader, rootPath: string | null, files: ReadonlyMap<string, FileInfo>, needed: boolean): Promise<Map<string, Map<string, number>>> {
  const index = new Map<string, Map<string, number>>();
  if (!needed || !rootPath) return index;
  for (const file of files.keys()) {
    if (!isGo(file)) continue;
    const source = await reader.readFile(path.join(rootPath, file));
    if (source === undefined) continue;
    const dir = path.posix.dirname(file);
    for (const name of source.match(/[A-Za-z_]\w*/gu) ?? []) {
      let byDir = index.get(name);
      if (!byDir) index.set(name, byDir = new Map());
      byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
    }
  }
  return index;
}

function mentionedOutside(index: Map<string, Map<string, number>>, name: string, dir: string): boolean {
  for (const mentionDir of index.get(name)?.keys() ?? []) {
    if (mentionDir !== dir) return true;
  }
  return false;
}

type Links = {
  // A function or class `target` used from `from` (a node id) or `fromFile`.
  uses: Array<{ target: string; from?: string; fromFile?: string }>;
  // Functions that handle routes, entrypoints or mounts.
  handlers: Set<string>;
  rootPath: string | null;
};

async function loadLinks(engine: IQueryEngine): Promise<Links> {
  const [calls, moduleCalls, callbacks, classLinks, handlers, repo] = await Promise.all([
    engine.query(`
      MATCH (caller:Function)-[:CALLS]->(:Call)-[:CALL_RESOLVES_TO]->(fn:Function)
      RETURN id(caller) AS source, id(fn) AS target
    `),
    engine.query(`
      MATCH (file:File)-[:MODULE_CALLS]->(:Call)-[:CALL_RESOLVES_TO]->(fn:Function)
      RETURN file.relativePath AS file, id(fn) AS target
    `),
    engine.query(`
      MATCH (fn:Function)-[:PASSED_TO]->(call:Call)
      OPTIONAL MATCH (caller:Function)-[:CALLS]->(call)
      OPTIONAL MATCH (file:File)-[:MODULE_CALLS]->(call)
      RETURN id(fn) AS target, id(caller) AS source, file.relativePath AS file
    `),
    engine.query(`
      MATCH (from:Class)-[:EXTENDS|IMPLEMENTS|INJECTS|MODULE_IMPORTS|MODULE_PROVIDES|MODULE_CONTROLS|MODULE_EXPORTS]->(to)
      RETURN id(from) AS source, id(to) AS target
    `),
    engine.query(`
      MATCH (owner)-[:ROUTE_HANDLED_BY|ROUTE_LIFECYCLE_STEP|ENTRYPOINT_HANDLED_BY|MOUNTS_FUNCTION]->(fn:Function)
      RETURN id(fn) AS target
    `),
    engine.query("MATCH (repo:Repo) RETURN repo.path AS path LIMIT 1"),
  ]) as Row[][];
  const id = (value: unknown) => (typeof value === "string" ? value : undefined);
  const uses: Links["uses"] = [];
  for (const row of [...calls!, ...callbacks!, ...classLinks!]) {
    const target = id(row.target);
    if (target) uses.push({ target, from: id(row.source), fromFile: id(row.file) });
  }
  for (const row of moduleCalls!) {
    const target = id(row.target);
    if (target) uses.push({ target, fromFile: id(row.file) });
  }
  return {
    uses,
    handlers: new Set(handlers!.flatMap((row) => id(row.target) ?? [])),
    rootPath: id(repo![0]?.path) ?? null,
  };
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Scan-relative files that are package entry points: the package.json
// fields main, module, types, browser, bin and exports, mapped back from
// build output to sources where the path does not exist, plus index and
// src/index files at the package root.
export async function packageEntries(reader: ISourceReader, packages: readonly Row[], files: ReadonlyMap<string, unknown>): Promise<string[]> {
  const entries = new Set<string>();
  for (const row of packages) {
    if (typeof row.path !== "string") continue;
    const base = typeof row.relativePath === "string" && row.relativePath !== "." ? row.relativePath : "";
    const targets = ["index", "src/index"];
    try {
      const manifest = JSON.parse((await reader.readFile(path.join(row.path, "package.json"))) ?? "") as Record<string, unknown>;
      for (const field of ["main", "module", "types", "typings", "browser", "bin", "exports"]) collectStrings(manifest[field], targets);
    } catch {
      // No readable manifest: the index fallbacks still apply.
    }
    for (const target of targets) {
      const resolved = resolveEntry(path.posix.join(base, target.replace(/^\.\//, "")), files);
      if (resolved) entries.add(resolved);
    }
  }
  return [...entries];
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, into);
}

function resolveEntry(target: string, files: ReadonlyMap<string, unknown>): string | null {
  const stem = target.replace(/\.d\.(?:m|c)?ts$/, "").replace(/\.(?:[mc]?[jt]sx?)$/, "");
  const stems = [stem, stem.replace(/(^|\/)(?:dist|lib|build|out|esm|cjs)\//, "$1src/")];
  for (const candidate of [target, ...stems.flatMap((item) => [...SOURCE_EXTENSIONS.map((extension) => item + extension), ...SOURCE_EXTENSIONS.map((extension) => `${item}/index${extension}`)])]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}
