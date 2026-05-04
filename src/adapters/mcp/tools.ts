import { quote } from "../kuzu/kuzu-format.js";

export type McpToolContent = {
  type: "text";
  text: string;
};

export type McpToolResult = {
  content: McpToolContent[];
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type GraphQueryEngine = {
  query(cypher: string): Promise<unknown[]>;
  stats(options?: { packageName?: string }): Promise<Array<{ table: string; count: unknown }>>;
  schemaVersion(): Promise<number | null>;
  close?(): Promise<void>;
};

export const mcpToolDefinitions: McpToolDefinition[] = [
  {
    name: "graph_stats",
    description: "Return schema version and node counts for the current Concentrate Kuzu graph.",
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
    description: "Find call sites that resolve to functions with the given name.",
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
];

export async function callMcpTool(
  engine: GraphQueryEngine,
  name: string,
  args: unknown,
): Promise<McpToolResult> {
  switch (name) {
    case "graph_stats":
      return textResult(await graphStats(engine, asObject(args)));
    case "find_definitions":
      return textResult(await findDefinitions(engine, asObject(args)));
    case "find_callers":
      return textResult(await findCallers(engine, asObject(args)));
    case "list_exports":
      return textResult(await listExports(engine, asObject(args)));
    case "trace_import_chain":
      return textResult(await traceImportChain(engine, asObject(args)));
    case "list_routes":
      return textResult(await listRoutes(engine, asObject(args)));
    case "list_entrypoints":
      return textResult(await listEntrypoints(engine, asObject(args)));
    case "list_env_config":
      return textResult(await listEnvConfig(engine, asObject(args)));
    case "list_data_access":
      return textResult(await listDataAccess(engine, asObject(args)));
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

async function graphStats(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<unknown> {
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
): Promise<unknown> {
  const name = requiredString(args.name, "name");
  const exact = optionalBoolean(args.exact) ?? false;
  const limit = optionalLimit(args.limit, 20);
  const rows = await definitionQueries(name, exact, limit);

  return { query: { name, exact, limit }, definitions: rows };

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
    return results.flat().slice(0, rowLimit);
  }
}

async function findCallers(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<unknown> {
  const name = requiredString(args.name, "name");
  const exact = optionalBoolean(args.exact) ?? true;
  const limit = optionalLimit(args.limit, 20);
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
    LIMIT ${limit}
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
    LIMIT ${limit}
  `);

  return { query: { name, exact, limit }, callers: [...functionCallers, ...moduleCallers].slice(0, limit) };
}

async function listExports(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<unknown> {
  const file = optionalString(args.file);
  const limit = optionalLimit(args.limit, 50);
  const fileFilter = file ? `AND file.relativePath = ${quote(file)}` : "";
  const queries = [
    exportQuery("Function", "DEFINES_FUNCTION", fileFilter, limit),
    exportQuery("Class", "DEFINES_CLASS", fileFilter, limit),
    exportQuery("Variable", "DEFINES_VARIABLE", fileFilter, limit),
    exportQuery("Interface", "DEFINES_INTERFACE", fileFilter, limit),
    exportQuery("TypeAlias", "DEFINES_TYPE_ALIAS", fileFilter, limit),
    exportQuery("Enum", "DEFINES_ENUM", fileFilter, limit),
    importReExportQuery(fileFilter, limit),
    reExportQuery("Function", "RE_EXPORTS_FUNCTION", fileFilter, limit),
    reExportQuery("Class", "RE_EXPORTS_CLASS", fileFilter, limit),
    reExportQuery("Variable", "RE_EXPORTS_VARIABLE", fileFilter, limit),
  ];
  const rows = (await Promise.all(queries.map((query) => engine.query(query)))).flat();

  return {
    query: { file, limit },
    exports: rows.slice(0, limit),
  };
}

async function traceImportChain(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<unknown> {
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
): Promise<unknown> {
  const file = optionalString(args.file);
  const framework = optionalString(args.framework);
  const limit = optionalLimit(args.limit, 50);
  const fileFilter = file ? `AND file.relativePath = ${quote(file)}` : "";
  const frameworkFilter = framework ? `AND route.framework = ${quote(framework)}` : "";
  const rows = await engine.query(`
    MATCH (file:File)-[:DECLARES_ROUTE]->(route:Route)
    OPTIONAL MATCH (route)-[:ROUTE_HANDLED_BY]->(handler:Function)
    WHERE true
      ${fileFilter}
      ${frameworkFilter}
    RETURN file.relativePath AS file,
      route.line AS line,
      route.method AS method,
      route.path AS path,
      route.fullPath AS fullPath,
      route.framework AS framework,
      route.handlerName AS handlerName,
      handler.name AS handler
    ORDER BY file.relativePath, route.line
    LIMIT ${limit}
  `);

  return { query: { file, framework, limit }, routes: rows };
}

async function listEntrypoints(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<unknown> {
  const kind = optionalString(args.kind);
  const file = optionalString(args.file);
  const limit = optionalLimit(args.limit, 50);
  const kindFilter = kind ? `AND entrypoint.kind = ${quote(kind)}` : "";
  const fileFilter = file ? `AND file.relativePath = ${quote(file)}` : "";
  const rows = await engine.query(`
    MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entrypoint:EntryPoint)
    OPTIONAL MATCH (entrypoint)-[:ENTRYPOINT_HANDLED_BY]->(handler:Function)
    WHERE true
      ${kindFilter}
      ${fileFilter}
    RETURN file.relativePath AS file,
      entrypoint.line AS line,
      entrypoint.kind AS kind,
      entrypoint.trigger AS trigger,
      entrypoint.library AS library,
      entrypoint.handlerName AS handlerName,
      handler.name AS handler
    ORDER BY file.relativePath, entrypoint.line
    LIMIT ${limit}
  `);

  return { query: { kind, file, limit }, entrypoints: rows };
}

async function listEnvConfig(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<unknown> {
  const file = optionalString(args.file);
  const name = optionalString(args.name);
  const limit = optionalLimit(args.limit, 50);
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
    LIMIT ${limit}
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
    LIMIT ${limit}
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
    LIMIT ${limit}
  `);

  return {
    query: { file, name, limit },
    envConfig: [...envRows, ...configRows, ...consumedRows].slice(0, limit),
  };
}

async function listDataAccess(
  engine: GraphQueryEngine,
  args: Record<string, unknown>,
): Promise<unknown> {
  const model = optionalString(args.model);
  const operation = optionalString(args.operation);
  const library = optionalString(args.library);
  const limit = optionalLimit(args.limit, 50);
  const filters = dataAccessFilters(model, operation, library);
  const queries = [
    dataAccessQuery("File", "ACCESSES_DATA_FILE", filters, limit),
    dataAccessQuery("Function", "ACCESSES_DATA_FUNCTION", filters, limit),
    dataAccessQuery("Route", "ACCESSES_DATA_ROUTE", filters, limit),
    dataAccessQuery("EntryPoint", "ACCESSES_DATA_ENTRYPOINT", filters, limit),
  ];
  const rows = (await Promise.all(queries.map((query) => engine.query(query)))).flat().slice(0, limit);

  return { query: { model, operation, library, limit }, dataAccess: rows };
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

function textResult(value: unknown): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
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
    RETURN '${sourceLabel}' AS sourceKind,
      ${sourceName} AS sourceName,
      file.relativePath AS file,
      rel.line AS line,
      model.name AS model,
      model.library AS library,
      rel.operation AS operation,
      rel.expression AS expression
    ORDER BY file.relativePath, rel.line
    LIMIT ${limit}
  `;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(200, Math.trunc(value)));
}
