import type { IQueryEngine } from "../contracts/query-engine.js";
import { countsAsCodeFile, loadFileGraph, topHubs } from "./hubs.js";

type Row = Record<string, unknown>;

const TOP_DIRECTORIES = 15;
const TOP_HUBS = 5;

export type GraphSummaryOptions = {
  // The languages whose files count as code (`LanguageTable.codeLanguages`).
  codeLanguages: ReadonlySet<string>;
};

export async function graphSummary(engine: IQueryEngine, options: GraphSummaryOptions): Promise<Record<string, unknown>> {
  const [schemaVersion, stats, repos, files, packages, routes, entrypoints, dataModels, tables, envVars, configValues] = await Promise.all([
    engine.schemaVersion(),
    engine.stats(),
    engine.query("MATCH (repo:Repo) RETURN repo.path AS path, repo.name AS name LIMIT 1"),
    engine.query("MATCH (file:File) RETURN file.relativePath AS file, file.language AS language, file.isTest AS isTest"),
    engine.query(`
      MATCH (package:Package)
      OPTIONAL MATCH (package)-[:PACKAGE_CONTAINS_FILE]->(file:File)
      RETURN package.name AS name, package.relativePath AS path, package.manager AS manager, count(file) AS files
      ORDER BY path, name
    `),
    engine.query("MATCH (route:Route) RETURN route.framework AS key, count(route) AS count ORDER BY key"),
    engine.query("MATCH (entrypoint:EntryPoint) RETURN entrypoint.kind AS key, count(entrypoint) AS count ORDER BY key"),
    engine.query("MATCH (model:DataModel) RETURN model.library AS key, count(model) AS count ORDER BY key"),
    engine.query("MATCH (table:Table) RETURN table.library AS key, count(table) AS count ORDER BY key"),
    engine.query("MATCH (env:EnvVar) RETURN count(env) AS count"),
    engine.query("MATCH (config:ConfigValue) RETURN count(config) AS count"),
  ]) as [number | null, unknown, Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[]];

  const languages = new Map<string, number>();
  const directories = new Map<string, number>();
  let testFiles = 0;
  let codeFiles = 0;
  for (const row of files) {
    if (countsAsCodeFile(row.language, options.codeLanguages)) codeFiles += 1;
    const language = String(row.language ?? "unknown");
    languages.set(language, (languages.get(language) ?? 0) + 1);
    if (row.isTest === true) testFiles += 1;
    // Files grouped by their first two path segments ("." for the root).
    const segments = String(row.file).split("/").slice(0, -1);
    const directory = segments.slice(0, 2).join("/") || ".";
    directories.set(directory, (directories.get(directory) ?? 0) + 1);
  }
  const byCount = (map: Map<string, number>) =>
    [...map].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b)).map(([name, count]) => ({ name, count }));
  const counts = (rows: Row[]) => Object.fromEntries(rows.map((row) => [String(row.key ?? "unknown"), Number(row.count)]));

  return {
    schemaVersion,
    repo: repos[0] ?? null,
    files: { total: files.length, code: codeFiles, tests: testFiles },
    languages: byCount(languages),
    packages,
    topDirectories: byCount(directories).slice(0, TOP_DIRECTORIES),
    routesByFramework: counts(routes),
    entrypointsByKind: counts(entrypoints),
    dataModelsByLibrary: counts(dataModels),
    tablesByLibrary: counts(tables),
    envVars: Number(envVars[0]?.count ?? 0),
    configValues: Number(configValues[0]?.count ?? 0),
    hubs: topHubs(await loadFileGraph(engine, options.codeLanguages), TOP_HUBS),
    stats,
  };
}
