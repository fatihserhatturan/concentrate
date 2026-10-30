import type { IQueryEngine } from "../../core/contracts/query-engine.js";
import { quote } from "./cypher.js";
import { agentTools, agentToolDefinitions } from "./agent-tools/index.js";
import { analysisTools, analysisToolDefinitions } from "./analysis-tools/index.js";
import { asObject, objectSchema, optionalBoolean, optionalLimit, optionalString, requiredString } from "./args.js";
import { fitToBudget } from "./budget.js";
import { INVALID_PARAMS, McpProtocolError } from "./errors.js";
import { pagedResult, pageWindow, type PageWindow } from "./paging.js";
import { listTables } from "./tables.js";

export type McpToolContent = {
  type: "text";
  text: string;
};

export type McpToolResult = {
  content: McpToolContent[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export type McpToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type GraphQueryEngine = IQueryEngine;

type ToolHandler = (engine: GraphQueryEngine, args: Record<string, unknown>, window: PageWindow) => Promise<Record<string, unknown>>;
// A paged tool returns its primary list (`listKey`) as `PageWindow.take` cut it.
export type McpTool = { handler: ToolHandler; listKey?: string; defaultLimit?: number };

const graphTools: Record<string, McpTool> = {
  graph_stats: { handler: graphStats },
  find_definitions: { handler: findDefinitions, listKey: "definitions", defaultLimit: 20 },
  find_callers: { handler: findCallers, listKey: "callers", defaultLimit: 20 },
  list_exports: { handler: listExports, listKey: "exports", defaultLimit: 50 },
  trace_import_chain: { handler: traceImportChain },
  list_routes: { handler: listRoutes, listKey: "routes", defaultLimit: 50 },
  list_pages: { handler: listPages, listKey: "pages", defaultLimit: 50 },
  list_entrypoints: { handler: listEntrypoints, listKey: "entrypoints", defaultLimit: 50 },
  list_env_config: { handler: listEnvConfig, listKey: "envConfig", defaultLimit: 50 },
  list_data_access: { handler: listDataAccess, listKey: "dataAccess", defaultLimit: 50 },
  list_tables: { handler: listTables, listKey: "tables", defaultLimit: 20 },
};
const tools: Record<string, McpTool> = { ...graphTools, ...agentTools, ...analysisTools };

const titles: Record<string, string> = {
  graph_stats: "Graph statistics",
  find_definitions: "Find definitions",
  find_callers: "Find callers",
  list_exports: "List exports",
  trace_import_chain: "Trace import chain",
  list_routes: "List HTTP routes",
  list_pages: "List UI pages",
  list_entrypoints: "List entrypoints",
  list_env_config: "List env vars and config",
  list_data_access: "List data access",
  list_tables: "List database tables",
  impact_of: "Impact of a change",
  detect_changes: "Detect working-tree changes",
  route_details: "Route details",
  api_consumers: "API consumers",
  get_symbol_source: "Get symbol source",
  get_file_outline: "Get file outline",
  component_tree: "Component tree",
  find_component_usages: "Find component usages",
  search_symbols: "Search symbols",
  find_references: "Find references",
  find_import_cycles: "Find import cycles",
  find_unused_exports: "Find unused exports",
  architecture_overview: "Architecture overview",
};

// Every tool only reads the graph (detect_changes also reads git), so the
// hints are the same for all of them.
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const cursorProperty = {
  type: "string",
  description: "Opaque cursor from page.nextCursor of the previous result, to fetch the next page. Repeat the other arguments unchanged.",
};

function describeTool(definition: McpToolDefinition): McpToolDefinition {
  const paged = tools[definition.name]?.listKey !== undefined;
  const schema = definition.inputSchema as { properties: Record<string, unknown> };
  return {
    name: definition.name,
    title: titles[definition.name],
    description: definition.description,
    inputSchema: paged ? { ...schema, properties: { ...schema.properties, cursor: cursorProperty } } : schema,
    annotations,
  };
}

export const mcpToolDefinitions: McpToolDefinition[] = [
  {
    name: "graph_stats",
    description: "Return schema version and node counts for the current Concentrate graph.",
    inputSchema: objectSchema({
      packageName: {
        type: "string",
        description: "Optional workspace package name or relative path to filter file-owned counts.",
      },
    }),
  },
  {
    name: "find_definitions",
    description: "Find definitions by symbol name across functions, classes, variables, interfaces, type aliases, and enums.",
    inputSchema: objectSchema({
      name: {
        type: "string",
        description: "Symbol name or substring to find.",
      },
      exact: {
        type: "boolean",
        description: "When true, match the symbol name exactly. Defaults to false.",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return. Defaults to 20.",
      },
    }, ["name"]),
  },
  {
    name: "find_callers",
    description: "Find call sites that resolve to functions with the given name. Callers can be functions, class methods (with className), or module-level code.",
    inputSchema: objectSchema({
      name: {
        type: "string",
        description: "Function or method name to find callers for.",
      },
      exact: {
        type: "boolean",
        description: "When true, match the function name exactly. Defaults to true.",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return. Defaults to 20.",
      },
    }, ["name"]),
  },
  {
    name: "list_exports",
    description: "List exported symbols and re-exports, optionally scoped to one file path.",
    inputSchema: objectSchema({
      file: {
        type: "string",
        description: "Optional file relative path.",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return. Defaults to 50.",
      },
    }),
  },
  {
    name: "trace_import_chain",
    description: "Find a resolved import path from one file to another file.",
    inputSchema: objectSchema({
      from: {
        type: "string",
        description: "Source file relative path.",
      },
      to: {
        type: "string",
        description: "Target file relative path.",
      },
      maxDepth: {
        type: "number",
        description: "Maximum import depth. Defaults to 6.",
      },
    }, ["from", "to"]),
  },
  {
    name: "list_routes",
    description: "List detected HTTP route declarations with source file, method, path, framework, and handler.",
    inputSchema: objectSchema({
      file: {
        type: "string",
        description: "Optional file relative path.",
      },
      framework: {
        type: "string",
        description: "Optional framework filter, such as express-koa or fastify.",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_pages",
    description: "List UI pages (Next.js App and Pages Router, React Router, TanStack Router, Vue Router) with source file, line, path as declared, full URL path, router, kind (page, layout, index, ...) and the component each renders, ordered by full path.",
    inputSchema: objectSchema({
      file: {
        type: "string",
        description: "Optional file relative path.",
      },
      framework: {
        type: "string",
        description: "Optional framework filter: nextjs, react-router, tanstack-router or vue-router.",
      },
      path: {
        type: "string",
        description: "Optional full path prefix of whole segments: /users matches /users and /users/:id.",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_entrypoints",
    description: "List non-HTTP backend entrypoints such as cron, queue, event, realtime, and scheduler handlers.",
    inputSchema: objectSchema({
      kind: {
        type: "string",
        description: "Optional entrypoint kind filter.",
      },
      file: {
        type: "string",
        description: "Optional file relative path.",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_env_config",
    description: "List environment variable uses and config declarations/consumers.",
    inputSchema: objectSchema({
      file: {
        type: "string",
        description: "Optional file relative path.",
      },
      name: {
        type: "string",
        description: "Optional env/config name substring.",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_data_access",
    description: "List data-access operations linked to files, functions, routes, or entrypoints.",
    inputSchema: objectSchema({
      model: {
        type: "string",
        description: "Optional model name substring.",
      },
      operation: {
        type: "string",
        description: "Optional operation filter such as read, create, update, or delete.",
      },
      library: {
        type: "string",
        description: "Optional data-access library filter.",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_tables",
    description: "Database tables, views and collections (from Prisma schema files, TypeORM entities, Mongoose schemas, Drizzle table definitions and Knex calls) with their columns, the ORM models that map to them and those models' relations, and the routes and entrypoints that read or write each table. Answers \"which endpoints write the users table?\".",
    inputSchema: objectSchema({
      name: { type: "string", description: "Optional table name substring." },
      library: { type: "string", description: "Optional library filter: prisma, typeorm, mongoose, drizzle or knex." },
      limit: { type: "number", description: "Page size. Defaults to 20, at most 200." },
    }),
  },
  ...agentToolDefinitions,
  ...analysisToolDefinitions,
].map(describeTool);

// Runs a tool. An unknown tool is a protocol error; errors the tool itself
// throws (bad arguments, an invalid cursor, git failing) propagate and the
// server turns them into `isError` results.
export async function callMcpTool(
  engine: GraphQueryEngine,
  name: string,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const tool = Object.hasOwn(tools, name) ? tools[name]! : undefined;
  if (!tool) throw new McpProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
  const args = asObject(rawArgs);
  const window = pageWindow(name, args, tool.defaultLimit ?? 50);
  const result = await tool.handler(engine, args, window);
  return jsonResult(tool.listKey !== undefined && Array.isArray(result[tool.listKey])
    ? pagedResult(name, args, window, result, tool.listKey)
    : fitToBudget(result));
}

async function graphStats(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const packageName = optionalString(args.packageName);
  return {
    schemaVersion: await engine.schemaVersion(),
    packageName,
    stats: await engine.stats({ packageName }),
  };
}

async function findDefinitions(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const name = requiredString(args.name, "name");
  const exact = optionalBoolean(args.exact) ?? false;
  const { limit, fetch } = window;
  const rows = await definitionQueries(name, exact, fetch);

  return { query: { name, exact, limit }, definitions: window.take(rows) };

  async function definitionQueries(symbolName: string, exactMatch: boolean, rowLimit: number): Promise<unknown[]> {
    const queries = [
      definitionQuery("Function", "DEFINES_FUNCTION", symbolName, exactMatch, rowLimit),
      definitionQuery("Class", "DEFINES_CLASS", symbolName, exactMatch, rowLimit),
      definitionQuery("Variable", "DEFINES_VARIABLE", symbolName, exactMatch, rowLimit),
      definitionQuery("Interface", "DEFINES_INTERFACE", symbolName, exactMatch, rowLimit),
      definitionQuery("TypeAlias", "DEFINES_TYPE_ALIAS", symbolName, exactMatch, rowLimit),
      definitionQuery("Enum", "DEFINES_ENUM", symbolName, exactMatch, rowLimit),
    ];
    const results = await Promise.all(queries.map((query) => engine.query(query)));
    return results.flat();
  }
}

async function findCallers(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const name = requiredString(args.name, "name");
  const exact = optionalBoolean(args.exact) ?? true;
  const { limit, fetch } = window;
  const predicate = namePredicate("target.name", name, exact);
  const functionCallers = await engine.query(`
    MATCH (call:Call)-[:CALL_RESOLVES_TO]->(target:Function)
    MATCH (caller:Function)-[:CALLS]->(call)
    MATCH (file:File)-[:DEFINES_FUNCTION]->(caller)
    WHERE ${predicate}
    RETURN target.name AS target,
      caller.name AS caller,
      'Function' AS callerKind,
      file.relativePath AS file,
      call.line AS line,
      call.expression AS expression,
      'CALLS' AS relationship
    ORDER BY file.relativePath, call.line
    LIMIT ${fetch}
  `);
  // Class methods hang off their class, not off the file.
  const methodCallers = await engine.query(`
    MATCH (call:Call)-[:CALL_RESOLVES_TO]->(target:Function)
    MATCH (caller:Function)-[:CALLS]->(call)
    MATCH (file:File)-[:DEFINES_CLASS]->(class:Class)-[:DEFINES_METHOD]->(caller)
    WHERE ${predicate}
    RETURN target.name AS target,
      caller.name AS caller,
      'Method' AS callerKind,
      class.name AS className,
      file.relativePath AS file,
      call.line AS line,
      call.expression AS expression,
      'CALLS' AS relationship
    ORDER BY file.relativePath, call.line
    LIMIT ${fetch}
  `);
  const moduleCallers = await engine.query(`
    MATCH (call:Call)-[:CALL_RESOLVES_TO]->(target:Function)
    MATCH (file:File)-[:MODULE_CALLS]->(call)
    WHERE ${predicate}
    RETURN target.name AS target,
      file.relativePath AS caller,
      'File' AS callerKind,
      file.relativePath AS file,
      call.line AS line,
      call.expression AS expression,
      'MODULE_CALLS' AS relationship
    ORDER BY file.relativePath, call.line
    LIMIT ${fetch}
  `);

  return { query: { name, exact, limit }, callers: window.take([...functionCallers, ...methodCallers, ...moduleCallers]) };
}

async function listExports(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const file = optionalString(args.file);
  const { limit, fetch } = window;
  const fileFilter = file ? `AND file.relativePath = ${quote(file)}` : "";
  const queries = [
    exportQuery("Function", "DEFINES_FUNCTION", fileFilter, fetch),
    exportQuery("Class", "DEFINES_CLASS", fileFilter, fetch),
    exportQuery("Variable", "DEFINES_VARIABLE", fileFilter, fetch),
    exportQuery("Interface", "DEFINES_INTERFACE", fileFilter, fetch),
    exportQuery("TypeAlias", "DEFINES_TYPE_ALIAS", fileFilter, fetch),
    exportQuery("Enum", "DEFINES_ENUM", fileFilter, fetch),
    importReExportQuery(fileFilter, fetch),
    reExportQuery("Function", "RE_EXPORTS_FUNCTION", fileFilter, fetch),
    reExportQuery("Class", "RE_EXPORTS_CLASS", fileFilter, fetch),
    reExportQuery("Variable", "RE_EXPORTS_VARIABLE", fileFilter, fetch),
  ];
  const rows = (await Promise.all(queries.map((query) => engine.query(query)))).flat();

  return {
    query: { file, limit },
    exports: window.take(rows),
  };
}

async function traceImportChain(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const from = requiredString(args.from, "from");
  const to = requiredString(args.to, "to");
  const maxDepth = optionalLimit(args.maxDepth, 6);
  const rows = await engine.query(`
    MATCH (source:File)-[:IMPORTS]->(:Import)-[:RESOLVES_TO]->(target:File)
    RETURN source.relativePath AS source, target.relativePath AS target
  `) as Array<{ source?: unknown; target?: unknown }>;
  const chain = findImportChain(rows, from, to, maxDepth);

  return {
    query: { from, to, maxDepth },
    found: chain !== null,
    chain,
  };
}

async function listRoutes(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const file = optionalString(args.file);
  const framework = optionalString(args.framework);
  const { limit, fetch } = window;
  const fileFilter = file ? `AND file.relativePath = ${quote(file)}` : "";
  const frameworkFilter = framework ? `AND route.framework = ${quote(framework)}` : "";
  const rows = await engine.query(`
    MATCH (file:File)-[:DECLARES_ROUTE]->(route:Route)
    WHERE true
      ${fileFilter}
      ${frameworkFilter}
    OPTIONAL MATCH (route)-[:ROUTE_HANDLED_BY]->(handler:Function)
    RETURN file.relativePath AS file,
      route.line AS line,
      route.method AS method,
      route.path AS path,
      route.fullPath AS fullPath,
      route.framework AS framework,
      route.handlerName AS handlerName,
      handler.name AS handler
    ORDER BY file.relativePath, route.line, route.method, route.path, handler.name
    LIMIT ${fetch}
  `);

  return { query: { file, framework, limit }, routes: window.take(rows) };
}

async function listPages(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const file = optionalString(args.file);
  const framework = optionalString(args.framework);
  const path = optionalString(args.path);
  const { limit, fetch } = window;
  const fileFilter = file ? `AND file.relativePath = ${quote(file)}` : "";
  const frameworkFilter = framework ? `AND page.framework = ${quote(framework)}` : "";
  // A prefix of whole segments: /users matches /users and /users/:id, not /usersettings.
  const prefix = path?.replace(/\/+$/u, "");
  const pathFilter = prefix ? `AND (page.fullPath = ${quote(prefix)} OR page.fullPath STARTS WITH ${quote(`${prefix}/`)})` : "";
  const rows = await engine.query(`
    MATCH (file:File)-[:DECLARES_PAGE]->(page:Page)
    WHERE true
      ${fileFilter}
      ${frameworkFilter}
      ${pathFilter}
    OPTIONAL MATCH (page)-[:PAGE_RENDERS]->(component:Component)<-[:DECLARES_COMPONENT]-(componentFile:File)
    RETURN page.fullPath AS fullPath,
      page.path AS path,
      page.framework AS framework,
      page.router AS router,
      page.kind AS kind,
      page.slot AS slot,
      file.relativePath AS file,
      page.line AS line,
      component.name AS component,
      componentFile.relativePath AS componentFile
    ORDER BY page.fullPath, file.relativePath, page.line, page.kind
    LIMIT ${fetch}
  `);

  return { query: { file, framework, path, limit }, pages: window.take(rows) };
}

async function listEntrypoints(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const kind = optionalString(args.kind);
  const file = optionalString(args.file);
  const { limit, fetch } = window;
  const kindFilter = kind ? `AND entrypoint.kind = ${quote(kind)}` : "";
  const fileFilter = file ? `AND file.relativePath = ${quote(file)}` : "";
  const rows = await engine.query(`
    MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entrypoint:EntryPoint)
    WHERE true
      ${kindFilter}
      ${fileFilter}
    OPTIONAL MATCH (entrypoint)-[:ENTRYPOINT_HANDLED_BY]->(handler:Function)
    RETURN file.relativePath AS file,
      entrypoint.line AS line,
      entrypoint.kind AS kind,
      entrypoint.trigger AS trigger,
      entrypoint.library AS library,
      entrypoint.handlerName AS handlerName,
      handler.name AS handler
    ORDER BY file.relativePath, entrypoint.line, entrypoint.kind, entrypoint.trigger, handler.name
    LIMIT ${fetch}
  `);

  return { query: { kind, file, limit }, entrypoints: window.take(rows) };
}

async function listEnvConfig(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const file = optionalString(args.file);
  const name = optionalString(args.name);
  const { limit, fetch } = window;
  const fileFilter = file ? `AND file.relativePath = ${quote(file)}` : "";
  const envNameFilter = name ? `AND contains(lower(env.name), lower(${quote(name)}))` : "";
  const configNameFilter = name ? `AND contains(lower(config.name), lower(${quote(name)}))` : "";
  const envRows = await engine.query(`
    MATCH (file:File)-[rel:USES_ENV_FILE]->(env:EnvVar)
    WHERE true
      ${fileFilter}
      ${envNameFilter}
    RETURN 'env' AS kind,
      file.relativePath AS file,
      rel.line AS line,
      env.name AS name,
      rel.access AS value,
      NULL AS valueType,
      file.relativePath AS consumer,
      'File' AS consumerKind
    ORDER BY file.relativePath, rel.line
    LIMIT ${fetch}
  `);
  const configRows = await engine.query(`
    MATCH (file:File)-[:DECLARES_CONFIG_FILE]->(config:ConfigValue)
    WHERE true
      ${fileFilter}
      ${configNameFilter}
    RETURN 'config' AS kind,
      file.relativePath AS file,
      config.line AS line,
      config.name AS name,
      config.value AS value,
      config.valueType AS valueType,
      file.relativePath AS consumer,
      'File' AS consumerKind
    ORDER BY file.relativePath, config.line
    LIMIT ${fetch}
  `);
  const consumedRows = await engine.query(`
    MATCH (file:File)-[rel:CONSUMES_CONFIG_FILE]->(config:ConfigValue)
    WHERE true
      ${fileFilter}
      ${configNameFilter}
    RETURN 'config-consumer' AS kind,
      file.relativePath AS file,
      config.line AS line,
      config.name AS name,
      config.value AS value,
      config.valueType AS valueType,
      rel.localName AS consumer,
      'File' AS consumerKind
    ORDER BY file.relativePath, config.line
    LIMIT ${fetch}
  `);

  return {
    query: { file, name, limit },
    envConfig: window.take([...envRows, ...configRows, ...consumedRows]),
  };
}

async function listDataAccess(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const model = optionalString(args.model);
  const operation = optionalString(args.operation);
  const library = optionalString(args.library);
  const { limit, fetch } = window;
  const filters = dataAccessFilters(model, operation, library);
  const queries = [
    dataAccessQuery("File", "ACCESSES_DATA_FILE", filters, fetch),
    dataAccessQuery("Function", "ACCESSES_DATA_FUNCTION", filters, fetch),
    dataAccessQuery("Route", "ACCESSES_DATA_ROUTE", filters, fetch),
    dataAccessQuery("EntryPoint", "ACCESSES_DATA_ENTRYPOINT", filters, fetch),
  ];
  const rows = (await Promise.all(queries.map((query) => engine.query(query)))).flat();

  return { query: { model, operation, library, limit }, dataAccess: window.take(rows) };
}

function findImportChain(
  rows: Array<{ source?: unknown; target?: unknown }>,
  from: string,
  to: string,
  maxDepth: number,
): string[] | null {
  const edges = new Map<string, string[]>();
  for (const row of rows) {
    const source = optionalString(row.source);
    const target = optionalString(row.target);
    if (!source || !target) continue;
    edges.set(source, [...(edges.get(source) ?? []), target]);
  }

  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    if (current === to) return path;
    if (path.length - 1 >= maxDepth) continue;

    for (const next of edges.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }

  return null;
}

// Structured content, plus the same JSON as text for clients that only read
// `content`. Both are the serialized value, so undefined fields are dropped
// from each alike. The text is compact JSON, the form the output budget
// measures.
function jsonResult(value: Record<string, unknown>): McpToolResult {
  const text = JSON.stringify(value);
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

export function toolErrorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], structuredContent: { error: message }, isError: true };
}


function namePredicate(property: string, value: string, exact: boolean): string {
  return exact
    ? `${property} = ${quote(value)}`
    : `contains(lower(${property}), lower(${quote(value)}))`;
}

function definitionQuery(
  label: string,
  relationship: string,
  value: string,
  exact: boolean,
  limit: number,
): string {
  return `
    MATCH (file:File)-[:${relationship}]->(n:${label})
    WHERE ${namePredicate("n.name", value, exact)}
    RETURN n.name AS name,
      '${label}' AS kind,
      file.relativePath AS file,
      n.line AS line,
      n.isExported AS isExported,
      '${relationship}' AS relationship
    ORDER BY file.relativePath, n.line, n.name
    LIMIT ${limit}
  `;
}

function exportQuery(label: string, relationship: string, fileFilter: string, limit: number): string {
  return `
    MATCH (file:File)-[:${relationship}]->(n:${label})
    WHERE n.isExported = true
      ${fileFilter}
    RETURN file.relativePath AS file,
      n.name AS name,
      '${label}' AS kind,
      n.line AS line,
      '${relationship}' AS relationship
    ORDER BY file.relativePath, n.line, n.name
    LIMIT ${limit}
  `;
}

function reExportQuery(label: string, relationship: string, fileFilter: string, limit: number): string {
  return `
    MATCH (file:File)-[:${relationship}]->(target:${label})
    WHERE true
      ${fileFilter}
    RETURN file.relativePath AS file,
      target.name AS name,
      '${label}' AS kind,
      target.line AS line,
      '${relationship}' AS relationship
    ORDER BY file.relativePath, target.line, target.name
    LIMIT ${limit}
  `;
}

function importReExportQuery(fileFilter: string, limit: number): string {
  return `
    MATCH (file:File)-[:RE_EXPORTS]->(target:Import)
    WHERE true
      ${fileFilter}
    RETURN file.relativePath AS file,
      target.source AS name,
      'Import' AS kind,
      target.line AS line,
      'RE_EXPORTS' AS relationship
    ORDER BY file.relativePath, target.line, target.source
    LIMIT ${limit}
  `;
}

function dataAccessFilters(model: string | undefined, operation: string | undefined, library: string | undefined): string {
  return [
    model ? `AND contains(lower(model.name), lower(${quote(model)}))` : "",
    operation ? `AND rel.operation = ${quote(operation)}` : "",
    library ? `AND model.library = ${quote(library)}` : "",
  ].filter(Boolean).join("\n      ");
}

function dataAccessQuery(sourceLabel: string, relationship: string, filters: string, limit: number): string {
  const fileMatch = sourceLabel === "File"
    ? "WITH source AS file, source, rel, model"
    : sourceLabel === "Function"
      ? "OPTIONAL MATCH (file:File)-[:DEFINES_FUNCTION]->(source)"
      : sourceLabel === "Route"
        ? "OPTIONAL MATCH (file:File)-[:DECLARES_ROUTE]->(source)"
        : "OPTIONAL MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(source)";
  const sourceName = sourceLabel === "File"
    ? "source.relativePath"
    : sourceLabel === "Route"
      ? "source.path"
      : sourceLabel === "EntryPoint"
        ? "source.trigger"
        : "source.name";

  return `
    MATCH (source:${sourceLabel})-[rel:${relationship}]->(model:DataModel)
    WHERE true
      ${filters}
    ${fileMatch}
    OPTIONAL MATCH (model)-[:MAPS_TO_TABLE]->(table:Table)
    RETURN '${sourceLabel}' AS sourceKind,
      ${sourceName} AS sourceName,
      file.relativePath AS file,
      rel.line AS line,
      model.name AS model,
      model.library AS library,
      table.name AS table,
      rel.operation AS operation,
      rel.expression AS expression
    ORDER BY file.relativePath, rel.line
    LIMIT ${limit}
  `;
}
