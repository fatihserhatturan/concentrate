import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { CODE_LANGUAGES, type SupportedLanguage } from "../../../core/scan/language.js";
import { optionalInteger, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { loadImports } from "./model.js";

type Row = Record<string, unknown>;

type Group = {
  name: string;
  files: number;
  testFiles: number;
  languages: Record<string, number>;
  functions: number;
  classes: number;
  routes: number;
  entrypoints: number;
  dataModels: Set<string>;
};

// architecture_overview: the repository as groups (workspace packages, or
// directories cut at `depth` path segments) with what each contains, and the
// import edges between groups weighted by the number of file imports.
export async function architectureOverview(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const level = optionalString(args.level) ?? "package";
  if (level !== "package" && level !== "directory") throw new Error(`Unknown level ${JSON.stringify(level)}; expected package or directory`);
  const depth = optionalInteger(args.depth, 2, 1, 6);

  const [files, membership, functionCounts, methodCounts, classCounts, routeCounts, entrypointCounts, fileModels, functionModels, declared, imports] = await Promise.all([
    engine.query("MATCH (file:File) RETURN file.relativePath AS file, file.language AS language, file.isTest AS isTest"),
    level === "package"
      ? engine.query(`
        MATCH (package:Package)-[:PACKAGE_CONTAINS_FILE]->(file:File)
        RETURN file.relativePath AS file, coalesce(package.name, package.relativePath) AS package
      `)
      : Promise.resolve([]),
    countPerFile(engine, "MATCH (file:File)-[:DEFINES_FUNCTION]->(n:Function)"),
    countPerFile(engine, "MATCH (file:File)-[:DEFINES_CLASS]->(:Class)-[:DEFINES_METHOD]->(n:Function)"),
    countPerFile(engine, "MATCH (file:File)-[:DEFINES_CLASS]->(n:Class)"),
    countPerFile(engine, "MATCH (file:File)-[:DECLARES_ROUTE]->(n:Route)"),
    countPerFile(engine, "MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(n:EntryPoint)"),
    engine.query("MATCH (file:File)-[:ACCESSES_DATA_FILE]->(model:DataModel) RETURN DISTINCT file.relativePath AS file, model.name AS model"),
    engine.query(`
      MATCH (file:File)-[:DEFINES_FUNCTION]->(:Function)-[:ACCESSES_DATA_FUNCTION]->(model:DataModel)
      RETURN DISTINCT file.relativePath AS file, model.name AS model
    `),
    level === "package"
      ? engine.query(`
        MATCH (from:Package)-[rel:PACKAGE_IMPORTS_PACKAGE]->(to:Package)
        RETURN coalesce(from.name, from.relativePath) AS source, coalesce(to.name, to.relativePath) AS target,
          rel.dependencyType AS dependencyType
      `)
      : Promise.resolve([]),
    loadImports(engine),
  ]) as [Row[], Row[], Map<string, number>, Map<string, number>, Map<string, number>, Map<string, number>, Map<string, number>, Row[], Row[], Row[], Awaited<ReturnType<typeof loadImports>>];

  const packageOf = new Map(membership.map((row) => [String(row.file), String(row.package)]));
  const groupOf = (file: string): string | null => level === "package"
    ? packageOf.get(file) ?? null
    : file.split("/").slice(0, -1).slice(0, depth).join("/") || ".";

  const groups = new Map<string, Group>();
  const group = (name: string) => {
    let entry = groups.get(name);
    if (!entry) {
      groups.set(name, entry = { name, files: 0, testFiles: 0, languages: {}, functions: 0, classes: 0, routes: 0, entrypoints: 0, dataModels: new Set() });
    }
    return entry;
  };
  let ungrouped = 0;
  for (const row of files) {
    // The structure of the code: styles, JSON, docs and assets are left out.
    if (typeof row.language === "string" && !CODE_LANGUAGES.has(row.language as SupportedLanguage)) continue;
    const file = String(row.file);
    const name = groupOf(file);
    if (name === null) {
      ungrouped++;
      continue;
    }
    const entry = group(name);
    entry.files++;
    if (row.isTest === true) entry.testFiles++;
    const language = String(row.language ?? "unknown");
    entry.languages[language] = (entry.languages[language] ?? 0) + 1;
    entry.functions += (functionCounts.get(file) ?? 0) + (methodCounts.get(file) ?? 0);
    entry.classes += classCounts.get(file) ?? 0;
    entry.routes += routeCounts.get(file) ?? 0;
    entry.entrypoints += entrypointCounts.get(file) ?? 0;
  }
  for (const row of [...fileModels, ...functionModels]) {
    const name = groupOf(String(row.file));
    if (name !== null && groups.has(name)) groups.get(name)!.dataModels.add(String(row.model));
  }

  // Edges between groups: resolved file imports, plus declared package
  // dependencies that no import uses.
  const edges = new Map<string, { from: string; to: string; imports: number; typeOnlyImports: number; dependencyTypes: Set<string> }>();
  const edge = (from: string, to: string) => {
    const key = `${from}\0${to}`;
    let entry = edges.get(key);
    if (!entry) edges.set(key, entry = { from, to, imports: 0, typeOnlyImports: 0, dependencyTypes: new Set() });
    return entry;
  };
  for (const item of imports) {
    if (!item.target) continue;
    const from = groupOf(item.file);
    const to = groupOf(item.target);
    if (from === null || to === null || from === to) continue;
    const entry = edge(from, to);
    entry.imports++;
    if (item.isTypeOnly) entry.typeOnlyImports++;
  }
  for (const row of declared) {
    const from = String(row.source);
    const to = String(row.target);
    if (from === to) continue;
    const entry = edge(from, to);
    if (typeof row.dependencyType === "string") entry.dependencyTypes.add(row.dependencyType);
  }

  const sortedEdges = [...edges.values()]
    .sort((a, b) => b.imports - a.imports || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .map(({ dependencyTypes, ...entry }) => ({ ...entry, ...(dependencyTypes.size > 0 ? { dependencyTypes: [...dependencyTypes].sort() } : {}) }));
  const dependencies = (name: string, direction: "from" | "to") =>
    sortedEdges.filter((entry) => entry[direction] === name).length;

  return {
    level,
    ...(level === "directory" ? { depth } : {}),
    groups: [...groups.values()]
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
      .map(({ dataModels, ...entry }) => ({
        ...entry,
        dataModels: dataModels.size,
        dependsOn: dependencies(entry.name, "from"),
        usedBy: dependencies(entry.name, "to"),
      })),
    ...(ungrouped > 0 ? { ungroupedFiles: ungrouped } : {}),
    totalEdges: sortedEdges.length,
    edges: window.take(sortedEdges),
    note: level === "package"
      ? "Groups are workspace packages; edges count resolved file imports between them (dependencyTypes: manifest entries and source imports the scanner recorded). Files outside every package are counted under ungroupedFiles."
      : `Groups are directories cut at ${depth} path segments ("." is the root); edges count resolved file imports between them.`,
  };
}

async function countPerFile(engine: IQueryEngine, match: string): Promise<Map<string, number>> {
  const rows = await engine.query(`${match} RETURN file.relativePath AS file, count(n) AS count`) as Row[];
  return new Map(rows.map((row) => [String(row.file), Number(row.count)]));
}
