import path from "node:path";
import type { IQueryEngine } from "../contracts/query-engine.js";
import type { ISourceReader } from "../contracts/source-reader.js";
import type { IUnusedExportRules, UnusedAnalysisContext, UnusedLanguageSession } from "../contracts/unused-rules.js";
import { loadFunctions, matchesFileOrDirectory } from "./graph.js";
import { type Declaration, describeDeclaration, ExportIndex, type FileInfo, loadDeclarations, loadFiles, loadImports } from "./model.js";

type Row = Record<string, unknown>;

// Why a file's exports are not judged: its whole export surface is public
// (a package entry point) or may be used without naming the export
// (namespace, dynamic or default imports, `export * as`).
type SurfaceReason = "packageEntry" | "wholeFileImported";

const MAX_DEAD_FUNCTIONS = 100;

export type FindUnusedExportsOptions = {
  /** Per-language rules; files no rule supports are not judged. */
  rules: readonly IUnusedExportRules[];
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
export async function findUnusedExports(engine: IQueryEngine, reader: ISourceReader, options: FindUnusedExportsOptions): Promise<UnusedExportsResult> {
  const file = options.file;
  const includeTests = options.includeTests ?? false;
  const languages = new Set(options.rules.flatMap((rule) => rule.languages));
  const ruleCache = new Map<string, IUnusedExportRules | undefined>();
  const ruleFor = (target: string) => {
    if (!ruleCache.has(target)) ruleCache.set(target, options.rules.find((rule) => rule.supports(target)));
    return ruleCache.get(target);
  };

  const [declarations, imports, files, packages, functions, links] = await Promise.all([
    loadDeclarations(engine, { fields: options.rules.some((rule) => rule.judges) }),
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
  for (const rule of options.rules) {
    for (const entry of await rule.packageEntries?.(reader, roots, files) ?? []) markSurface(entry, "packageEntry");
  }
  for (const edge of imports) {
    if (!edge.target || edge.isReExport) continue;
    // `from m import *` takes every public name of `m` (or its `__all__`).
    if (edge.isWildcard && ruleFor(edge.file)?.wildcardImportUsesWholeFile) {
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
  // A language may group files into one unit (a Go package, a Rust crate, a C header with its source).
  const scopeOf = (target: string) => ruleFor(target)?.unitOf?.(target, files.get(target)) ?? target;
  const calledAnywhere = new Set<string>();
  for (const link of links.uses) {
    calledAnywhere.add(link.target);
    const from = link.fromFile ?? (link.from ? fileOf(link.from) : null);
    const target = fileOf(link.target);
    if (from && target && scopeOf(from) !== scopeOf(target)) used.add(link.target);
  }

  const inScope = (declaration: Declaration) => {
    const info = files.get(declaration.file);
    return info !== undefined && languages.has(info.language ?? "") && (!file || matchesFileOrDirectory(declaration.file, file));
  };
  const skipped: Record<string, number> = { packageEntry: 0, wholeFileImported: 0, defaultExports: 0, tests: 0, generated: 0, handlers: 0 };
  for (const rule of options.rules) for (const reason of rule.skipReasons ?? []) skipped[reason] = 0;
  // Per language, once the scan holds declarations of it: names the graph has
  // no edges for that other units mention.
  const sessions = new Map<IUnusedExportRules, UnusedLanguageSession>();
  let annotations: Map<string, string[]> | undefined;
  for (const rule of options.rules) {
    if (!rule.createSession) continue;
    const own = declarations.filter((declaration) => rule.supports(declaration.file));
    if (own.length === 0) continue;
    annotations ??= await loadAnnotations(engine);
    const written = annotations;
    const context: UnusedAnalysisContext = {
      rootPath: links.rootPath,
      declarations: own,
      unitOf: scopeOf,
      annotationsOf: (id) => written.get(id) ?? [],
      forEachSource: async (include, visit) => {
        if (!links.rootPath) return;
        for (const candidate of files.keys()) {
          if (!include(candidate)) continue;
          const text = await reader.readFile(path.join(links.rootPath, candidate));
          if (text !== undefined) visit(candidate, text);
        }
      },
    };
    sessions.set(rule, await rule.createSession(context));
  }
  const skipReason = (declaration: Declaration, info: FileInfo): string | null => {
    const rule = ruleFor(declaration.file);
    const binary = rule?.binaryReason?.(declaration, info);
    if (binary) return binary;
    if (!includeTests && (info.isTest || info.isFixture)) return "tests";
    const entry = rule?.entryReason?.(declaration, info);
    if (entry) return entry;
    if (info.isGenerated) return "generated";
    if (links.handlers.has(declaration.id)) return "handlers";
    // Default exports are what tools and frameworks load by convention (configs, pages).
    if (declaration.name === "default") return "defaultExports";
    return surfaces.get(declaration.file) ?? null;
  };

  const unused: UnusedExport[] = [];
  for (const declaration of declarations) {
    const rule = ruleFor(declaration.file);
    const judged = rule?.judges ? rule.judges(declaration) : declaration.isExported && declaration.kind !== "method";
    if (!judged || used.has(declaration.id) || !inScope(declaration)) continue;
    if (rule?.isPublicApi && !rule.isPublicApi(declaration)) continue;
    if (rule && sessions.get(rule)?.isMentionedElsewhere?.(declaration)) continue;
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
    const rule = ruleFor(declaration.file);
    const unitMentions = rule && sessions.get(rule)?.deadFunctionMentions;
    if (unitMentions) {
      if (unitMentions(declaration) <= 1) deadFunctions.push({ id: declaration.id, ...describeDeclaration(declaration) });
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

// Annotation / decorator names by the id of the type, method or field that carries them.
async function loadAnnotations(engine: IQueryEngine): Promise<Map<string, string[]>> {
  const relations = ["HAS_METHOD_DECORATOR", "HAS_DECORATOR", "INTERFACE_HAS_DECORATOR", "FIELD_HAS_DECORATOR"];
  const result = new Map<string, string[]>();
  for (const relation of relations) {
    // A store without the language's relationship table has none of them.
    const rows = await engine.query(`MATCH (owner)-[:${relation}]->(decorator:Decorator) RETURN id(owner) AS owner, decorator.name AS name`).catch(() => []) as Row[];
    for (const row of rows) {
      if (typeof row.owner === "string" && typeof row.name === "string") result.set(row.owner, [...result.get(row.owner) ?? [], row.name]);
    }
  }
  return result;
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
