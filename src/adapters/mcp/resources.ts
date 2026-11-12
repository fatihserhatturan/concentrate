import type { IQueryEngine } from "../../core/contracts/query-engine.js";
import { CODE_LANGUAGES, type SupportedLanguage } from "../../core/scan/language.js";
import { INVALID_PARAMS, McpProtocolError } from "./errors.js";
import { loadFileGraph, topHubs } from "./analysis-tools/hubs.js";

// MCP resources: one JSON summary of the scanned graph, small enough for an
// agent to read before choosing tools.

export const GRAPH_SUMMARY_URI = "concentrate://graph/summary";

export const resourceDefinitions = [
  {
    uri: GRAPH_SUMMARY_URI,
    name: "graph-summary",
    title: "Graph summary",
    description: "Overview of the scanned repository: node counts, languages, packages, the largest directories, hubs (most connected files, most called functions), routes and entrypoints by framework, and data model, env var and config counts.",
    mimeType: "application/json",
  },
];

type Row = Record<string, unknown>;

const TOP_DIRECTORIES = 15;
const TOP_HUBS = 5;

export async function readResource(engine: IQueryEngine, uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  if (uri !== GRAPH_SUMMARY_URI) throw new McpProtocolError(INVALID_PARAMS, `Resource not found: ${uri}`, { uri });
  const summary = await graphSummary(engine);
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(summary, null, 2) }] };
}

export async function graphSummary(engine: IQueryEngine): Promise<Record<string, unknown>> {
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
    if (typeof row.language !== "string" || CODE_LANGUAGES.has(row.language as SupportedLanguage)) codeFiles += 1;
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
    hubs: topHubs(await loadFileGraph(engine), TOP_HUBS),
    stats,
  };
}
