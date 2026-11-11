import type { IQueryEngine } from "../../core/contracts/query-engine.js";
import { quote } from "./cypher.js";
import { agentTools, agentToolDefinitions } from "./agent-tools/index.js";
import { analysisTools, analysisToolDefinitions } from "./analysis-tools/index.js";
import { asObject, objectSchema, optionalBoolean, optionalLimit, optionalString, requiredString } from "./args.js";
import { fitToBudget } from "./budget.js";
import { INVALID_PARAMS, McpProtocolError } from "./errors.js";
import { pagedResult, pageWindow, type PageWindow } from "./paging.js";
import { byFileAndLine, callerCompleteness, filesMatching, matchesFileOrDirectory, NO_FILE_MATCHED, unresolvedCalls } from "./agent-tools/graph.js";
import { listStores } from "./stores.js";
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
  list_stores: { handler: listStores, listKey: "stores", defaultLimit: 20 },
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
  list_stores: "List state stores",
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
  description: "page.nextCursor of the previous result.",
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
    description: "Schema version and node counts of the graph.",
    inputSchema: objectSchema({
      packageName: {
        type: "string",
        description: "Workspace package name or relative path; limits file-owned counts.",
      },
    }),
  },
  {
    name: "find_definitions",
    description: "Definitions by name: functions, classes, variables, interfaces (with implementations), type aliases, enums, and class methods (last, with className).",
    inputSchema: objectSchema({
      name: {
        type: "string",
        description: "Symbol name or substring.",
      },
      exact: {
        type: "boolean",
        description: "Match the name exactly. Defaults to false.",
      },
      limit: {
        type: "number",
        description: "Page size. Defaults to 20.",
      },
    }, ["name"]),
  },
  {
    name: "find_callers",
    description: "Call sites that resolve to functions or methods of this name; a caller is a function, a method (with className) or module-level code. A call through an interface reaches every implementation (targetClassName). unresolvedCalls and completeness say whether any call by that name is unresolved.",
    inputSchema: objectSchema({
      name: {
        type: "string",
        description: "Function or method name.",
      },
      exact: {
        type: "boolean",
        description: "Match the name exactly. Defaults to true.",
      },
      limit: {
        type: "number",
        description: "Page size. Defaults to 20.",
      },
    }, ["name"]),
  },
  {
    name: "list_exports",
    description: "Exported symbols and re-exports.",
    inputSchema: objectSchema({
      file: {
        type: "string",
        description: "File or directory path (scan-relative), or a path suffix.",
      },
      limit: {
        type: "number",
        description: "Page size. Defaults to 50.",
      },
    }),
  },
  {
    name: "trace_import_chain",
    description: "A resolved import path from one file to another.",
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
    description: "HTTP routes with file, line, method, path, full path, framework and handler. Registrations whose method or path is computed at runtime (`app[method](url, fn)`) come back in dynamicRouteCalls. unconsumed: true lists the routes no scanned frontend call reaches.",
    inputSchema: objectSchema({
      file: {
        type: "string",
        description: "File or directory path (scan-relative), or a path suffix.",
      },
      framework: {
        type: "string",
        description: "Framework, such as express-koa, fastify, gin, chi or net/http.",
      },
      unconsumed: {
        type: "boolean",
        description: "Only routes no call in the graph requests (see api_consumers), middleware mounts left out. Defaults to false.",
      },
      limit: {
        type: "number",
        description: "Page size. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_pages",
    description: "UI pages (Next.js App and Pages Router, React Router, TanStack Router, Vue Router, Nuxt, SvelteKit, Astro, Angular Router) with file, line, path as declared, full URL path, router, kind (page, layout, index, ...) and the component each renders.",
    inputSchema: objectSchema({
      file: {
        type: "string",
        description: "File or directory path (scan-relative), or a path suffix.",
      },
      framework: {
        type: "string",
        description: "nextjs, react-router, tanstack-router, vue-router, nuxt, sveltekit, astro or angular.",
      },
      path: {
        type: "string",
        description: "Full path prefix of whole segments: /users matches /users and /users/:id.",
      },
      limit: {
        type: "number",
        description: "Page size. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_entrypoints",
    description: "Non-HTTP backend entrypoints: cron, queue, event, realtime and scheduler handlers; Go main, init, gRPC methods, cobra commands (cli); scripts, make targets, npm scripts, Docker, compose services and CI jobs (kinds script, make, npm-script, docker, compose-service, ci-job), with what each runs.",
    inputSchema: objectSchema({
      kind: {
        type: "string",
        description: "Entrypoint kind.",
      },
      file: {
        type: "string",
        description: "File or directory path (scan-relative), or a path suffix.",
      },
      limit: {
        type: "number",
        description: "Page size. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_env_config",
    description: "Env variable reads, and config declarations with their consumers. unread: true lists the variables .env files declare that no code reads, and those code reads that no env file declares.",
    inputSchema: objectSchema({
      file: {
        type: "string",
        description: "File or directory path (scan-relative), or a path suffix.",
      },
      name: {
        type: "string",
        description: "Env or config name substring.",
      },
      unread: {
        type: "boolean",
        description: "List unread and undeclared env variables instead. Defaults to false.",
      },
      limit: {
        type: "number",
        description: "Page size. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_data_access",
    description: "Data-access operations (Prisma, TypeORM, Sequelize, Knex, Mongoose, Drizzle; Go gorm, ent, bun, sqlc, sql, sqlx) with the files, functions, routes and entrypoints that run them. direct: true rows (first) make the call; others reach it. line is in accessFile.",
    inputSchema: objectSchema({
      model: {
        type: "string",
        description: "Model name substring.",
      },
      operation: {
        type: "string",
        description: "read, create, update, upsert or delete.",
      },
      library: {
        type: "string",
        description: "Data-access library, such as prisma, typeorm or gorm.",
      },
      direct: {
        type: "boolean",
        description: "Only rows that make the call. Defaults to false.",
      },
      limit: {
        type: "number",
        description: "Page size. Defaults to 50.",
      },
    }),
  },
  {
    name: "list_tables",
    description: "Database tables, views and collections (Prisma, TypeORM, Mongoose, Drizzle, Knex; Go gorm, ent, sqlc; SQL migrations) with columns, indexes, migration history, the models mapped to them and their relations, and the routes and entrypoints that use each.",
    inputSchema: objectSchema({
      name: { type: "string", description: "Table name substring." },
      library: { type: "string", description: "prisma, typeorm, mongoose, drizzle, knex, gorm, ent, bun, sqlc or sql." },
      limit: { type: "number", description: "Page size. Defaults to 20, at most 200." },
    }),
  },
  {
    name: "list_stores",
    description: "Frontend state stores (Pinia, Redux Toolkit, Zustand, Jotai, Svelte) with state, getters, actions, the functions that define them, and the functions that read or write them (with the members used). For the components and pages a store change reaches, use impact_of with its name.",
    inputSchema: objectSchema({
      name: { type: "string", description: "Store name or hook substring." },
      library: { type: "string", description: "pinia, redux, zustand, jotai or svelte." },
      file: { type: "string", description: "Declaring file or directory path, or a path suffix." },
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

  return { query: { name, exact, limit }, definitions: await withImplementations(engine, window.take(rows) as DefinitionRow[]) };

  async function definitionQueries(symbolName: string, exactMatch: boolean, rowLimit: number): Promise<unknown[]> {
    const queries = [
      definitionQuery("Function", "DEFINES_FUNCTION", symbolName, exactMatch, rowLimit),
      definitionQuery("Class", "DEFINES_CLASS", symbolName, exactMatch, rowLimit),
      definitionQuery("Variable", "DEFINES_VARIABLE", symbolName, exactMatch, rowLimit),
      definitionQuery("Interface", "DEFINES_INTERFACE", symbolName, exactMatch, rowLimit),
      definitionQuery("TypeAlias", "DEFINES_TYPE_ALIAS", symbolName, exactMatch, rowLimit),
      definitionQuery("Enum", "DEFINES_ENUM", symbolName, exactMatch, rowLimit),
      // Last, so methods never push declarations off the first page.
      methodDefinitionQuery(symbolName, exactMatch, rowLimit),
    ];
    const results = await Promise.all(queries.map((query) => engine.query(query)));
    return results.flat();
  }
}

type DefinitionRow = { name: string; kind: string; file: string; line: number; implementations?: Array<{ name: string; file: string; line: number }> };

// An interface row lists the classes that implement it, so a question about
// an interface's implementations (or the dispatch targets of its methods)
// is answered by the definition itself.
async function withImplementations(engine: GraphQueryEngine, rows: DefinitionRow[]): Promise<DefinitionRow[]> {
  const interfaces = rows.filter((row) => row.kind === "Interface");
  if (interfaces.length === 0) return rows;
  const found = await engine.query(`
    MATCH (file:File)-[:DEFINES_INTERFACE]->(target:Interface)
    MATCH (classFile:File)-[:DEFINES_CLASS]->(cls:Class)-[:IMPLEMENTS]->(target)
    WHERE target.name IN [${[...new Set(interfaces.map((row) => quote(row.name)))].join(", ")}]
    RETURN target.name AS interfaceName, file.relativePath AS interfaceFile, target.line AS interfaceLine,
      cls.name AS name, classFile.relativePath AS file, cls.line AS line
    ORDER BY classFile.relativePath, cls.line
  `) as Array<{ interfaceName: string; interfaceFile: string; interfaceLine: number; name: string; file: string; line: number }>;
  for (const row of interfaces) {
    const implementations = found
      .filter((match) => match.interfaceName === row.name && match.interfaceFile === row.file && match.interfaceLine === row.line)
      .map(({ name, file, line }) => ({ name, file, line }));
    if (implementations.length > 0) row.implementations = implementations;
  }
  return rows;
}

type CallerRow = { target: string; targetId?: string; targetClassName?: string; targetFile?: string };

// When more than one function has the name (a method that several classes
// implement, so a call through an interface resolves to each of them), every
// row says which one it reaches.
async function withTargets(engine: GraphQueryEngine, rows: CallerRow[], predicate: string): Promise<CallerRow[]> {
  const ids = [...new Set(rows.map((row) => row.targetId!))];
  const [{ targets }] = await engine.query(`MATCH (target:Function) WHERE ${predicate} RETURN count(target) AS targets`) as Array<{ targets: number }>;
  if (ids.length > 0 && Number(targets) > 1) {
    const list = ids.map(quote).join(", ");
    const located = await engine.query(`
      MATCH (file:File)-[:DEFINES_CLASS]->(cls:Class)-[:DEFINES_METHOD]->(target:Function)
      WHERE target.id IN [${list}]
      RETURN target.id AS id, cls.name AS className, file.relativePath AS file
    `) as Array<{ id: string; className?: string; file: string }>;
    located.push(...await engine.query(`
      MATCH (file:File)-[:DEFINES_FUNCTION]->(target:Function)
      WHERE target.id IN [${list}]
      RETURN target.id AS id, file.relativePath AS file
    `) as Array<{ id: string; file: string }>);
    const byId = new Map(located.map((target) => [target.id, target]));
    for (const row of rows) {
      const target = byId.get(row.targetId!);
      if (target?.className) row.targetClassName = target.className;
      if (target) row.targetFile = target.file;
    }
  }
  for (const row of rows) delete row.targetId;
  return rows;
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
      target.id AS targetId,
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
      target.id AS targetId,
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
      target.id AS targetId,
      file.relativePath AS caller,
      'File' AS callerKind,
      file.relativePath AS file,
      call.line AS line,
      call.expression AS expression,
      'MODULE_CALLS' AS relationship
    ORDER BY file.relativePath, call.line
    LIMIT ${fetch}
  `);

  const names = exact
    ? [name]
    : [...new Set((await engine.query(`
      MATCH (target:Function)
      WHERE ${predicate}
      RETURN DISTINCT target.name AS name
      ORDER BY name
      LIMIT ${CALLER_NAME_LIMIT}
    `) as Array<{ name: string }>).map((row) => row.name))];

  return {
    query: { name, exact, limit },
    callers: await withTargets(engine, window.take([...functionCallers, ...methodCallers, ...moduleCallers]) as CallerRow[], predicate),
    ...callerCompleteness(names, await unresolvedCalls(engine, names)),
  };
}

// Function names a substring search checks for unresolved calls.
const CALLER_NAME_LIMIT = 20;

async function listExports(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const file = optionalString(args.file);
  const { limit, fetch } = window;
  const { fileFilter, fileNote } = await fileScope(engine, file);
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
    ...fileNote,
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
  const { fileFilter, fileNote } = await fileScope(engine, file);
  const unconsumed = optionalBoolean(args.unconsumed) ?? false;
  const frameworkFilter = framework ? `AND route.framework = ${quote(framework)}` : "";
  // Routes no scanned call requests; middleware mounts (USE) are not endpoints.
  const unconsumedFilter = unconsumed
    ? `AND route.method <> 'USE'
    OPTIONAL MATCH (:Call)-[request:REQUESTS]->(route)
    WITH file, route, count(request) AS consumers
    WHERE consumers = 0`
    : "";
  const rows = await engine.query(`
    MATCH (file:File)-[:DECLARES_ROUTE]->(route:Route)
    WHERE true
      ${fileFilter}
      ${frameworkFilter}
      ${unconsumedFilter}
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

  // Registrations with a computed method or path (`app[method](url, fn)`)
  // make no Route; they are listed so the caller knows to read the source.
  const dynamicFiles = await engine.query(`
    MATCH (file:File)
    WHERE file.dynamicRouteCalls IS NOT NULL
      ${fileFilter}
    RETURN file.relativePath AS file, file.dynamicRouteCalls AS calls
    ORDER BY file.relativePath
  `) as Array<{ file: string; calls: string }>;
  const dynamicRouteCalls = dynamicFiles.flatMap((row) => (
    (JSON.parse(row.calls) as Array<{ line: number; expression: string; framework: string }>)
      .filter((call) => !framework || call.framework === framework)
      .map((call) => ({ file: row.file, line: call.line, expression: call.expression, framework: call.framework }))
  ));
  const dynamic = dynamicRouteCalls.length > 0
    ? {
      dynamicRouteCalls: dynamicRouteCalls.slice(0, DYNAMIC_ROUTE_CALL_LIMIT),
      dynamicNote: `${dynamicRouteCalls.length} route registration${dynamicRouteCalls.length === 1 ? "" : "s"} with a method or path computed at runtime ${dynamicRouteCalls.length === 1 ? "is" : "are"} not listed as routes; read the source at these lines for the routes ${dynamicRouteCalls.length === 1 ? "it registers" : "they register"}.`,
    }
    : {};

  // Without any linked request (a backend scanned alone, or URLs that do not
  // resolve), every route is unconsumed, which says nothing about dead code.
  const requests = unconsumed
    ? await engine.query("MATCH (:Call)-[request:REQUESTS]->(:Route) RETURN count(request) AS count") as Array<{ count: number }>
    : [];
  const unconsumedNote = unconsumed && Number(requests[0]?.count ?? 0) === 0
    ? { unconsumedNote: "No call in the graph requests any route (no frontend in the scan, or its URLs did not resolve), so every route is listed; this is not evidence that they are unused." }
    : {};

  return { query: { file, framework, ...(unconsumed ? { unconsumed } : {}), limit }, routes: window.take(rows), ...unconsumedNote, ...dynamic, ...fileNote };
}

const DYNAMIC_ROUTE_CALL_LIMIT = 20;

async function listPages(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const file = optionalString(args.file);
  const framework = optionalString(args.framework);
  const path = optionalString(args.path);
  const { limit, fetch } = window;
  const { fileFilter, fileNote } = await fileScope(engine, file);
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

  return { query: { file, framework, path, limit }, pages: window.take(rows), ...fileNote };
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
  const { fileFilter, fileNote } = await fileScope(engine, file);
  const rows = await engine.query(`
    MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entrypoint:EntryPoint)
    WHERE true
      ${kindFilter}
      ${fileFilter}
    OPTIONAL MATCH (entrypoint)-[:ENTRYPOINT_HANDLED_BY]->(handler:Function)
    RETURN id(entrypoint) AS id,
      file.relativePath AS file,
      entrypoint.line AS line,
      entrypoint.kind AS kind,
      entrypoint.trigger AS trigger,
      entrypoint.library AS library,
      entrypoint.handlerName AS handlerName,
      handler.name AS handler
    ORDER BY file.relativePath, entrypoint.line, entrypoint.kind, entrypoint.trigger, handler.name
    LIMIT ${fetch}
  `) as Array<Record<string, unknown>>;

  // What scripts, make targets, npm scripts, compose services and CI jobs
  // start (`RUNS`), for the page's entrypoints.
  const page = window.take(rows);
  const ids = page.map((row) => row.id);
  const [fileRuns, entryRuns] = ids.length === 0 ? [[], []] : await Promise.all([
    engine.query(`
      MATCH (entrypoint:EntryPoint)-[run:RUNS_FILE]->(target:File)
      WHERE id(entrypoint) IN $ids
      RETURN id(entrypoint) AS id, target.relativePath AS file, run.line AS line, run.command AS command
      ORDER BY run.line, target.relativePath
    `, { ids }),
    engine.query(`
      MATCH (entrypoint:EntryPoint)-[run:RUNS_ENTRYPOINT]->(target:EntryPoint)
      MATCH (targetFile:File)-[:DECLARES_ENTRYPOINT]->(target)
      WHERE id(entrypoint) IN $ids
      RETURN id(entrypoint) AS id, targetFile.relativePath AS file, target.kind AS kind, target.trigger AS trigger, run.line AS line, run.command AS command
      ORDER BY run.line, targetFile.relativePath, target.trigger
    `, { ids }),
  ]) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];
  const runsById = new Map<unknown, Array<Record<string, unknown>>>();
  for (const row of fileRuns) runsById.set(row.id, [...runsById.get(row.id) ?? [], { file: row.file, command: row.command }]);
  for (const row of entryRuns) runsById.set(row.id, [...runsById.get(row.id) ?? [], { file: row.file, entrypoint: `${String(row.kind)}:${String(row.trigger)}`, command: row.command }]);
  const entrypoints = page.map(({ id, ...row }) => (runsById.has(id) ? { ...row, runs: runsById.get(id) } : row));

  return { query: { kind, file, limit }, entrypoints, ...fileNote };
}

async function listEnvConfig(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
  window: PageWindow,
): Promise<Record<string, unknown>> {
  const file = optionalString(args.file);
  const name = optionalString(args.name);
  if (optionalBoolean(args.unread)) return unreadEnv(engine, file, name, window);
  const { limit, fetch } = window;
  const { fileFilter, fileNote } = await fileScope(engine, file);
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
    ...fileNote,
  };
}

// Env variables an env file declares that no code reads (`unread`), and
// variables code reads that no scanned env file declares (`undeclared`; only
// when there is an env file, and not NODE_ENV, which tooling sets).
async function unreadEnv(engine: GraphQueryEngine, file: string | undefined, name: string | undefined, window: PageWindow) {
  const nameFilter = name ? `AND contains(lower(env.name), lower(${quote(name)}))` : "";
  const reads = "USES_ENV_FILE|USES_ENV_FUNCTION|USES_ENV_ROUTE|USES_ENV_REPO|USES_ENV_ENTRYPOINT";
  const unread = await engine.query(`
    MATCH (:Repo)-[decl:DECLARES_ENV]->(env:EnvVar)
    WHERE true ${nameFilter}
    OPTIONAL MATCH ()-[read:${reads}]->(env)
    WITH env, decl, count(read) AS readCount
    WHERE readCount = 0
    RETURN 'unread' AS kind, env.name AS name, decl.file AS file, decl.line AS line
  `) as Array<Record<string, unknown>>;
  const declarations = await engine.query("MATCH (:Repo)-[decl:DECLARES_ENV]->(env:EnvVar) RETURN DISTINCT env.name AS name") as Array<{ name: string }>;
  const declared = new Set(declarations.map((row) => row.name));
  const readQuery = (owner: string) => engine.query(`
    MATCH ${owner}-[read:USES_ENV_FILE|USES_ENV_FUNCTION]->(env:EnvVar)
    WHERE env.name <> 'NODE_ENV' ${nameFilter}
    RETURN 'undeclared' AS kind, env.name AS name, file.relativePath AS file, read.line AS line
  `) as Promise<Array<Record<string, unknown>>>;
  const undeclared = declared.size === 0 ? [] : (await Promise.all([
    readQuery("(file:File)"),
    readQuery("(file:File)-[:DEFINES_FUNCTION]->(:Function)"),
    readQuery("(file:File)-[:DEFINES_CLASS]->(:Class)-[:DEFINES_METHOD]->(:Function)"),
    // Scripts, Makefile targets and `package.json` scripts read env too.
    engine.query(`
      MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(:EntryPoint)-[read:USES_ENV_ENTRYPOINT]->(env:EnvVar)
      WHERE env.name <> 'NODE_ENV' ${nameFilter}
      RETURN 'undeclared' AS kind, env.name AS name, file.relativePath AS file, read.line AS line
    `) as Promise<Array<Record<string, unknown>>>,
    engine.query(`
      MATCH (:Repo)-[read:USES_ENV_REPO]->(env:EnvVar)
      WHERE true ${nameFilter}
      RETURN 'undeclared' AS kind, env.name AS name, read.file AS file, read.line AS line
    `) as Promise<Array<Record<string, unknown>>>,
  ])).flat().filter((row) => !declared.has(String(row.name)));
  const seen = new Set<string>();
  const rows = [...unread, ...undeclared]
    .filter((row) => !file || matchesFileOrDirectory(String(row.file), file))
    .filter((row) => {
      const key = `${row.kind}:${row.name}:${row.file}:${row.line}`;
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || byFileAndLine(a, b));
  return {
    query: { file, name, unread: true, limit: window.limit },
    envConfig: window.take(rows),
    ...(declared.size === 0 ? { note: "No scanned env file (.env, .env.*) declares a variable, so nothing is unread or undeclared; gitignored env files are not scanned." } : {}),
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
  const direct = args.direct === true;
  const { limit, fetch } = window;
  const filters = [dataAccessFilters(model, operation, library), direct ? "AND rel.direct = true" : ""].filter(Boolean).join("\n      ");
  const queries = [
    dataAccessQuery("File", "ACCESSES_DATA_FILE", filters, fetch),
    dataAccessQuery("Function", "ACCESSES_DATA_FUNCTION", filters, fetch),
    dataAccessQuery("Route", "ACCESSES_DATA_ROUTE", filters, fetch),
    dataAccessQuery("EntryPoint", "ACCESSES_DATA_ENTRYPOINT", filters, fetch),
  ];
  // Direct accesses first, each kind in its query's order. A method has no
  // DEFINES_FUNCTION (its class has it, in another file in Go): its file is
  // the start of its id (`file:<path>:function:...`).
  const rows = (await Promise.all(queries.map((query) => engine.query(query)))).flat()
    .map((row, index) => ({ row: row as Record<string, unknown>, index }))
    .sort((a, b) => Number(b.row.direct === true) - Number(a.row.direct === true) || a.index - b.index)
    .map(({ row: { sourceId, ...row } }) => ({ ...row, file: row.file ?? fileOfFunctionId(sourceId) }));

  return { query: { model, operation, library, direct, limit }, dataAccess: window.take(rows) };
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

// Methods of classes, including class fields that hold a function. A method
// is exported when its class is.
function methodDefinitionQuery(value: string, exact: boolean, limit: number): string {
  return `
    MATCH (file:File)-[:DEFINES_CLASS]->(cls:Class)-[:DEFINES_METHOD]->(n:Function)
    WHERE ${namePredicate("n.name", value, exact)}
    RETURN n.name AS name,
      'Method' AS kind,
      file.relativePath AS file,
      n.line AS line,
      cls.isExported AS isExported,
      'DEFINES_METHOD' AS relationship,
      cls.name AS className
    ORDER BY file.relativePath, n.line, n.name
    LIMIT ${limit}
  `;
}

// A file argument as a Cypher filter on `file.relativePath`: the files it
// selects as a file, a directory or a path suffix, with a note when none.
async function fileScope(engine: GraphQueryEngine, file: string | undefined) {
  if (!file) return { fileFilter: "", fileNote: {} };
  const files = await filesMatching(engine, file);
  return files.length === 0
    ? { fileFilter: "AND false", fileNote: { note: NO_FILE_MATCHED } }
    : { fileFilter: `AND file.relativePath IN [${files.map(quote).join(", ")}]`, fileNote: {} };
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

function fileOfFunctionId(id: unknown): string | null {
  if (typeof id !== "string" || !id.startsWith("file:")) return null;
  const end = id.indexOf(":function:");
  return end > 5 ? id.slice(5, end) : null;
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
      id(source) AS sourceId,
      rel.direct AS direct,
      rel.file AS accessFile,
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
