import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import type { PageWindow } from "../paging.js";

// Graph reads shared by the agent-facing tools. Functions are identified by
// node id (`id(fn)` in Cypher); everything else is looked up from those ids.

export type FunctionInfo = {
  id: string;
  name: string;
  className: string | null;
  file: string | null;
  line: number | null;
  endLine: number | null;
};

export type CallEdge = { caller: string; callee: string; line: number | null };

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

// Every function with its defining file; class methods are reached through
// their class. Restrict to `ids` when given.
export async function loadFunctions(engine: IQueryEngine, ids?: readonly string[]): Promise<Map<string, FunctionInfo>> {
  const filter = ids ? "WHERE id(fn) IN $ids" : "";
  const params = ids ? { ids: [...ids] } : {};
  const [fileFunctions, methods] = await Promise.all([
    engine.query(`
      MATCH (file:File)-[:DEFINES_FUNCTION]->(fn:Function)
      ${filter}
      RETURN id(fn) AS id, fn.name AS name, fn.className AS className, file.relativePath AS file,
        fn.line AS line, fn.endLine AS endLine
    `, params),
    engine.query(`
      MATCH (file:File)-[:DEFINES_CLASS]->(class:Class)-[:DEFINES_METHOD]->(fn:Function)
      ${filter}
      RETURN id(fn) AS id, fn.name AS name, class.name AS className, file.relativePath AS file,
        fn.line AS line, fn.endLine AS endLine
    `, params),
  ]);

  const functions = new Map<string, FunctionInfo>();
  for (const row of [...fileFunctions, ...methods] as Row[]) {
    const id = str(row.id);
    if (!id || functions.has(id)) continue;
    functions.set(id, {
      id,
      name: str(row.name) ?? "",
      className: str(row.className),
      file: str(row.file),
      line: num(row.line),
      endLine: num(row.endLine),
    });
  }
  return functions;
}

// Resolved function-to-function calls: caller -[:CALLS]-> Call -[:CALL_RESOLVES_TO]-> callee.
export async function loadCallEdges(engine: IQueryEngine): Promise<CallEdge[]> {
  const rows = await engine.query(`
    MATCH (caller:Function)-[:CALLS]->(call:Call)-[:CALL_RESOLVES_TO]->(callee:Function)
    RETURN id(caller) AS caller, id(callee) AS callee, call.line AS line
  `) as Row[];
  return rows.flatMap((row) => {
    const caller = str(row.caller);
    const callee = str(row.callee);
    return caller && callee ? [{ caller, callee, line: num(row.line) }] : [];
  });
}

// Breadth-first walk from `seeds` along call edges: "up" follows callers,
// "down" follows callees. Returns each reached function with its distance;
// seeds have distance 0.
export function walkCalls(
  edges: readonly CallEdge[],
  seeds: Iterable<string>,
  direction: "up" | "down",
  maxDepth: number,
): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const [from, to] = direction === "up" ? [edge.callee, edge.caller] : [edge.caller, edge.callee];
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
  }

  const depth = new Map<string, number>();
  let frontier = [...new Set(seeds)];
  for (const id of frontier) depth.set(id, 0);
  for (let level = 1; level <= maxDepth && frontier.length > 0; level++) {
    const reached: string[] = [];
    for (const id of frontier) {
      for (const neighbour of next.get(id) ?? []) {
        if (depth.has(neighbour)) continue;
        depth.set(neighbour, level);
        reached.push(neighbour);
      }
    }
    frontier = reached;
  }
  return depth;
}

export function describeFunction(info: FunctionInfo | undefined, id: string) {
  return {
    name: info?.name ?? id,
    className: info?.className ?? null,
    file: info?.file ?? null,
    line: info?.line ?? null,
    endLine: info?.endLine ?? null,
  };
}

type Located = { file?: unknown; line?: unknown };

// Sorts rows that may carry `file` and `line`.
export const byFileAndLine = (left: object, right: object) => {
  const a = left as Located;
  const b = right as Located;
  return String(a.file ?? "").localeCompare(String(b.file ?? "")) || (Number(a.line) || 0) - (Number(b.line) || 0);
};

// What is affected when the `seedIds` functions change: their transitive
// callers (up to `maxDepth`), module-level code that calls them, the routes
// and entrypoints that run any of those functions, and the data models, env
// vars and config values the seeds themselves use. Components implemented by
// any of those functions add the components that render them, and the pages
// that render any of those components.
export async function computeImpact(
  engine: IQueryEngine,
  seedIds: readonly string[],
  maxDepth: number,
  limit: number,
  loaded?: Map<string, FunctionInfo>,
  // Pages the callers list; without it, callers are capped at `limit` like the other lists.
  callersWindow?: PageWindow,
) {
  const [functions, edges] = await Promise.all([loaded ?? loadFunctions(engine), loadCallEdges(engine)]);
  const depth = walkCalls(edges, seedIds, "up", maxDepth);
  const affectedIds = [...depth.keys()];
  const seeds = [...new Set(seedIds)];
  const name = (id: string) => describeFunction(functions.get(id), id);

  const [moduleCallers, routes, entrypoints, resources, components] = await Promise.all([
    engine.query(`
      MATCH (file:File)-[:MODULE_CALLS]->(call:Call)-[:CALL_RESOLVES_TO]->(fn:Function)
      WHERE id(fn) IN $ids
      RETURN file.relativePath AS file, call.line AS line, call.expression AS expression, id(fn) AS fn
    `, { ids: affectedIds }),
    engine.query(`
      MATCH (file:File)-[:DECLARES_ROUTE]->(route:Route)-[rel:ROUTE_HANDLED_BY|ROUTE_LIFECYCLE_STEP]->(fn:Function)
      WHERE id(fn) IN $ids
      RETURN id(route) AS routeId, route.method AS method, route.path AS path, route.fullPath AS fullPath, route.framework AS framework,
        file.relativePath AS file, route.line AS line, label(rel) AS relType, rel.role AS role, id(fn) AS fn
    `, { ids: affectedIds }),
    engine.query(`
      MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entrypoint:EntryPoint)-[:ENTRYPOINT_HANDLED_BY]->(fn:Function)
      WHERE id(fn) IN $ids
      RETURN entrypoint.kind AS kind, entrypoint.trigger AS trigger, entrypoint.library AS library,
        file.relativePath AS file, entrypoint.line AS line, id(fn) AS fn
    `, { ids: affectedIds }),
    functionResources(engine, seeds),
    componentImpact(engine, affectedIds, maxDepth, name),
  ]) as [Row[], Row[], Row[], FunctionResources, Awaited<ReturnType<typeof componentImpact>>];

  // Across the API boundary: the calls that reach the affected routes, and
  // the components and pages whose code makes them.
  const routeIds = [...new Set(routes.map((route) => String(route.routeId)))];
  const consumers = routeIds.length > 0
    ? await apiConsumers(engine, routeIds, maxDepth, functions, edges)
    : { consumers: [], components: [], pages: [] };

  const via = (row: Row) => ({
    function: name(String(row.fn)).name,
    functionFile: name(String(row.fn)).file,
    ...(row.relType !== undefined
      ? { as: row.relType === "ROUTE_HANDLED_BY" ? "handler" : String(row.role ?? "lifecycle"), relType: row.relType }
      : {}),
  });

  return {
    seeds: seeds.map(name).sort(byFileAndLine),
    callers: affectedIds
      .filter((id) => depth.get(id)! > 0)
      .map((id) => ({ ...name(id), depth: depth.get(id)! }))
      .sort((a, b) => a.depth - b.depth || byFileAndLine(a, b))
      .slice(callersWindow?.offset ?? 0, callersWindow ? callersWindow.offset + callersWindow.limit + 1 : limit),
    moduleCallers: moduleCallers
      .map(({ fn, ...row }) => ({ ...row, calls: name(String(fn)).name, callsFile: name(String(fn)).file }))
      .sort(byFileAndLine)
      .slice(0, limit),
    routes: mergeRows(routes.map(({ routeId: _routeId, ...route }) => route), ["fn", "relType", "role"], "reachedThrough", via)
      .map((route) => ({ ...route, reachedThrough: preferLifecycleRoles(route.reachedThrough as Row[]) }))
      .sort(byFileAndLine)
      .slice(0, limit),
    entrypoints: mergeRows(entrypoints, ["fn"], "reachedThrough", via).sort(byFileAndLine).slice(0, limit),
    components: components.components.slice(0, limit),
    pages: components.pages.slice(0, limit),
    apiConsumers: consumers.consumers.map(describeConsumer).slice(0, limit),
    consumerComponents: consumers.components.slice(0, limit),
    consumerPages: consumers.pages.slice(0, limit),
    dataAccess: mergeRows(resources.dataAccess, ["fn"], "usedBy", via).slice(0, limit),
    tables: summarizeTables(resources.tables, via).slice(0, limit),
    envVars: mergeRows(resources.envVars, ["fn"], "usedBy", via).slice(0, limit),
    config: mergeRows(resources.config, ["fn"], "usedBy", via).slice(0, limit),
  };
}

// ROUTE_HANDLED_BY also links route-level middleware, so a function with a
// lifecycle role keeps only that role.
function preferLifecycleRoles(items: Row[]): Row[] {
  const withRole = new Set(items.filter((item) => item.relType !== "ROUTE_HANDLED_BY").map((item) => item.function));
  return items
    .filter((item) => item.relType !== "ROUTE_HANDLED_BY" || !withRole.has(item.function))
    .map(({ relType: _relType, ...item }) => item);
}

// Merges rows that are equal apart from the `varying` columns into one row,
// collecting `describe(row)` of each merged row (without repeats) under `into`.
// The result keeps first-seen order of the merged rows.
export function mergeRows(
  rows: readonly Row[],
  varying: readonly string[],
  into: string,
  describe: (row: Row) => Row,
): Row[] {
  const merged = new Map<string, { row: Row; items: Row[]; seen: Set<string> }>();
  for (const row of rows) {
    const fixed = Object.fromEntries(Object.entries(row).filter(([column]) => !varying.includes(column)));
    const key = JSON.stringify(fixed);
    let entry = merged.get(key);
    if (!entry) {
      entry = { row: fixed, items: [], seen: new Set() };
      merged.set(key, entry);
    }
    const item = describe(row);
    const itemKey = JSON.stringify(item);
    if (!entry.seen.has(itemKey)) {
      entry.seen.add(itemKey);
      entry.items.push(item);
    }
  }
  return [...merged.values()].map(({ row, items }) => ({ ...row, [into]: items }));
}

export type FunctionResources = { dataAccess: Row[]; tables: Row[]; envVars: Row[]; config: Row[] };

// Data models, tables, env vars and config values used directly by the `ids`
// functions. Each row carries the using function's id as `fn`.
export async function functionResources(engine: IQueryEngine, ids: readonly string[]): Promise<FunctionResources> {
  const params = { ids: [...ids] };
  const [dataAccess, tables, envVars, config] = await Promise.all([
    engine.query(`
      MATCH (fn:Function)-[rel:ACCESSES_DATA_FUNCTION]->(model:DataModel)
      WHERE id(fn) IN $ids
      RETURN model.name AS model, model.library AS library, rel.operation AS operation,
        rel.line AS line, rel.expression AS expression, id(fn) AS fn
    `, params),
    engine.query(`
      MATCH (fn:Function)-[rel:READS_FUNCTION|WRITES_FUNCTION]->(table:Table)
      WHERE id(fn) IN $ids
      RETURN ${tableAccessColumns}, id(fn) AS fn
    `, params),
    engine.query(`
      MATCH (fn:Function)-[rel:USES_ENV_FUNCTION]->(env:EnvVar)
      WHERE id(fn) IN $ids
      RETURN env.name AS name, rel.access AS access, rel.line AS line, id(fn) AS fn
    `, params),
    engine.query(`
      MATCH (fn:Function)-[rel:CONSUMES_CONFIG_FUNCTION]->(config:ConfigValue)
      WHERE id(fn) IN $ids
      RETURN config.name AS name, rel.localName AS localName, id(fn) AS fn
    `, params),
  ]) as Row[][];
  return { dataAccess, tables, envVars, config };
}

// Columns of a READS_* / WRITES_* row, bound as `rel` to `table`.
export const tableAccessColumns = `id(table) AS tableId, table.name AS table, table.kind AS kind, table.library AS library,
  label(rel) AS tableAccess, rel.operation AS operation`;

// One entry per table: the read and write operations on it and who performs
// them (`describe(row)`, without repeats).
export function summarizeTables(rows: readonly Row[], describe: (row: Row) => Row): Row[] {
  const tables = new Map<string, { entry: { table: unknown; kind: unknown; library: unknown }; reads: Set<string>; writes: Set<string>; usedBy: Map<string, Row> }>();
  for (const row of rows) {
    const id = String(row.tableId);
    let table = tables.get(id);
    if (!table) {
      table = { entry: { table: row.table, kind: row.kind, library: row.library }, reads: new Set(), writes: new Set(), usedBy: new Map() };
      tables.set(id, table);
    }
    (String(row.tableAccess).startsWith("READS") ? table.reads : table.writes).add(String(row.operation));
    const item = describe(row);
    table.usedBy.set(JSON.stringify(item), item);
  }
  return [...tables.values()]
    .map(({ entry, reads, writes, usedBy }) => ({ ...entry, reads: [...reads].sort(), writes: [...writes].sort(), usedBy: [...usedBy.values()] }))
    .sort((a, b) => String(a.table).localeCompare(String(b.table)) || String(a.library).localeCompare(String(b.library)));
}

// A file argument matches a graph file by its scan-relative path, or by a
// path suffix ("users/service.ts" matches "src/users/service.ts").
export function matchesFile(relativePath: string | null, file: string): boolean {
  if (!relativePath) return false;
  const wanted = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return relativePath === wanted || relativePath.endsWith(`/${wanted}`);
}

export type SymbolKind = "function" | "method" | "class" | "interface" | "type" | "enum" | "variable" | "route";

export type SymbolInfo = {
  id: string;
  kind: SymbolKind;
  name: string;
  className: string | null;
  file: string;
  path: string;
  line: number | null;
  endLine: number | null;
};

// Declarations with their line spans, optionally restricted to some files
// and/or one name. Variables and routes only have a start line. Routes are
// named "METHOD path".
export async function loadSymbols(
  engine: IQueryEngine,
  filter: { files?: readonly string[]; name?: string } = {},
): Promise<SymbolInfo[]> {
  const where = (node: string, nameProperty: string | null) => {
    const conditions = [
      filter.files ? "file.relativePath IN $files" : null,
      filter.name !== undefined && nameProperty ? `${node}.${nameProperty} = $name` : null,
    ].filter(Boolean);
    return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  };
  const params = { files: filter.files ? [...filter.files] : [], name: filter.name ?? "" };
  const fileColumns = "file.relativePath AS file, file.path AS path";
  const spanned = (label: string, relationship: string, kind: SymbolKind) => ({
    kind,
    cypher: `
      MATCH (file:File)-[:${relationship}]->(n:${label})
      ${where("n", "name")}
      RETURN id(n) AS id, n.name AS name, ${fileColumns}, n.line AS line, n.endLine AS endLine
    `,
  });
  const queries: Array<{ kind: SymbolKind; cypher: string }> = [
    {
      kind: "function",
      cypher: `
        MATCH (file:File)-[:DEFINES_FUNCTION]->(n:Function)
        ${where("n", "name")}
        RETURN id(n) AS id, n.name AS name, n.className AS className, ${fileColumns}, n.line AS line, n.endLine AS endLine
      `,
    },
    {
      kind: "method",
      cypher: `
        MATCH (file:File)-[:DEFINES_CLASS]->(class:Class)-[:DEFINES_METHOD]->(n:Function)
        ${where("n", "name")}
        RETURN id(n) AS id, n.name AS name, class.name AS className, ${fileColumns}, n.line AS line, n.endLine AS endLine
      `,
    },
    spanned("Class", "DEFINES_CLASS", "class"),
    spanned("Interface", "DEFINES_INTERFACE", "interface"),
    spanned("TypeAlias", "DEFINES_TYPE_ALIAS", "type"),
    spanned("Enum", "DEFINES_ENUM", "enum"),
    {
      kind: "variable",
      cypher: `
        MATCH (file:File)-[:DEFINES_VARIABLE]->(n:Variable)
        ${where("n", "name")}
        RETURN id(n) AS id, n.name AS name, ${fileColumns}, n.line AS line
      `,
    },
  ];
  if (filter.name === undefined) {
    queries.push({
      kind: "route",
      cypher: `
        MATCH (file:File)-[:DECLARES_ROUTE]->(n:Route)
        ${where("n", null)}
        RETURN id(n) AS id, n.method AS method, coalesce(n.fullPath, n.path) AS routePath, ${fileColumns}, n.line AS line
      `,
    });
  }

  const results = await Promise.all(queries.map(({ cypher }) => engine.query(cypher, params) as Promise<Row[]>));
  const seen = new Set<string>();
  const symbols: SymbolInfo[] = [];
  results.forEach((rows, index) => {
    const kind = queries[index]!.kind;
    for (const row of rows) {
      const id = str(row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = kind === "route" ? `${str(row.method)?.toUpperCase() ?? ""} ${str(row.routePath) ?? ""}`.trim() : str(row.name) ?? "";
      const className = str(row.className);
      symbols.push({
        id,
        // A function node that belongs to a class is a method even when it is
        // reached through DEFINES_FUNCTION.
        kind: kind === "function" && className ? "method" : kind,
        name,
        className,
        file: str(row.file) ?? "",
        path: str(row.path) ?? "",
        line: num(row.line),
        endLine: num(row.endLine),
      });
    }
  });
  return symbols.sort(byFileAndLine);
}

export type ComponentInfo = {
  id: string;
  name: string;
  kind: string | null;
  framework: string | null;
  file: string | null;
  line: number | null;
  endLine: number | null;
  isExported: boolean | null;
  tagName: string | null;
  // Declared prop names (Vue), in order.
  props: string[];
  // Built-in and custom hooks the component calls, by name.
  hooks: string[];
  // Rendered elements that resolved to no Component (library components).
  unresolvedRenders: Array<{ name: string; props: string[]; line: number | null }>;
};

export type RenderEdge = { parent: string; child: string; line: number | null; props: string[] };

// Every component with its declaring file.
export async function loadComponents(engine: IQueryEngine): Promise<Map<string, ComponentInfo>> {
  const rows = await engine.query(`
    MATCH (file:File)-[:DECLARES_COMPONENT]->(component:Component)
    RETURN id(component) AS id, component.name AS name, component.kind AS kind, component.framework AS framework,
      file.relativePath AS file, component.line AS line, component.endLine AS endLine,
      component.isExported AS isExported, component.tagName AS tagName, component.props AS props, component.hooks AS hooks,
      component.pendingRenders AS pendingRenders
  `) as Row[];
  const components = new Map<string, ComponentInfo>();
  for (const row of rows) {
    const id = str(row.id);
    if (!id || components.has(id)) continue;
    components.set(id, {
      id,
      name: str(row.name) ?? "",
      kind: str(row.kind),
      framework: str(row.framework),
      file: str(row.file),
      line: num(row.line),
      endLine: num(row.endLine),
      isExported: typeof row.isExported === "boolean" ? row.isExported : null,
      tagName: str(row.tagName),
      props: str(row.props)?.split(",").filter(Boolean) ?? [],
      hooks: str(row.hooks)?.split(",").filter(Boolean) ?? [],
      unresolvedRenders: parseRenders(row.pendingRenders),
    });
  }
  return components;
}

function parseRenders(value: unknown): ComponentInfo["unresolvedRenders"] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: { name?: unknown; props?: unknown; line?: unknown }) =>
      typeof item?.name === "string"
        ? [{ name: item.name, props: Array.isArray(item.props) ? item.props.filter((prop): prop is string => typeof prop === "string") : [], line: num(item.line) }]
        : []);
  } catch {
    return [];
  }
}

// Component -[:RENDERS]-> Component.
export async function loadRenderEdges(engine: IQueryEngine): Promise<RenderEdge[]> {
  const rows = await engine.query(`
    MATCH (parent:Component)-[rel:RENDERS]->(child:Component)
    RETURN id(parent) AS parent, id(child) AS child, rel.line AS line, rel.props AS props
  `) as Row[];
  return rows.flatMap((row) => {
    const parent = str(row.parent);
    const child = str(row.child);
    return parent && child
      ? [{ parent, child, line: num(row.line), props: str(row.props)?.split(",").filter(Boolean) ?? [] }]
      : [];
  });
}

// The functions that implement each component: its function, or the methods
// of its class (`className` set). Restrict to components implemented by the
// `functionIds` functions when given.
export async function loadComponentFunctions(
  engine: IQueryEngine,
  functionIds?: readonly string[],
): Promise<Array<{ component: string; fn: string; className: string | null }>> {
  const filter = functionIds ? "WHERE id(fn) IN $ids" : "";
  const params = functionIds ? { ids: [...functionIds] } : {};
  const [functions, methods] = await Promise.all([
    engine.query(`
      MATCH (component:Component)-[:COMPONENT_DEFINED_BY_FUNCTION]->(fn:Function)
      ${filter}
      RETURN id(component) AS component, id(fn) AS fn
    `, params),
    engine.query(`
      MATCH (component:Component)-[:COMPONENT_DEFINED_BY]->(class:Class)-[:DEFINES_METHOD]->(fn:Function)
      ${filter}
      RETURN id(component) AS component, id(fn) AS fn, class.name AS className
    `, params),
  ]) as Row[][];
  return [...functions, ...methods].flatMap((row) => {
    const component = str(row.component);
    const fn = str(row.fn);
    return component && fn ? [{ component, fn, className: str(row.className) }] : [];
  });
}

// The components implemented by the `affectedIds` functions, and every
// component that renders them (up to `maxDepth` levels). Depth 0 is a
// component whose own code is affected. `pages` are the pages that render
// any of them, at the depth of the component they render.
export async function componentImpact(
  engine: IQueryEngine,
  affectedIds: readonly string[],
  maxDepth: number,
  describe: (id: string) => ReturnType<typeof describeFunction>,
) {
  const implementations = await loadComponentFunctions(engine, affectedIds);
  if (implementations.length === 0) return { components: [], pages: [] };
  const [components, renders] = await Promise.all([loadComponents(engine), loadRenderEdges(engine)]);

  const changedThrough = new Map<string, Set<string>>();
  for (const { component, fn } of implementations) {
    const through = changedThrough.get(component) ?? new Set();
    through.add(describe(fn).name);
    changedThrough.set(component, through);
  }
  const depth = walkCalls(renders.map(({ parent, child, line }) => ({ caller: parent, callee: child, line })), changedThrough.keys(), "up", maxDepth);
  const renderedChildren = new Map<string, Set<string>>();
  for (const edge of renders) {
    if (!depth.has(edge.parent) || !depth.has(edge.child) || depth.get(edge.parent)! !== depth.get(edge.child)! + 1) continue;
    const children = renderedChildren.get(edge.parent) ?? new Set();
    children.add(components.get(edge.child)?.name ?? edge.child);
    renderedChildren.set(edge.parent, children);
  }

  const pageRows = await engine.query(`
    MATCH (file:File)-[:DECLARES_PAGE]->(page:Page)-[:PAGE_RENDERS]->(component:Component)
    WHERE id(component) IN $ids
    RETURN page.fullPath AS fullPath, page.framework AS framework, page.router AS router, page.kind AS kind,
      file.relativePath AS file, page.line AS line, id(component) AS component
  `, { ids: [...depth.keys()] }) as Row[];
  const pages = pageRows.map((row) => ({
    fullPath: str(row.fullPath),
    framework: str(row.framework),
    router: str(row.router),
    kind: str(row.kind),
    file: str(row.file),
    line: num(row.line),
    renders: components.get(String(row.component))?.name ?? String(row.component),
    depth: depth.get(String(row.component))!,
  })).sort((a, b) => a.depth - b.depth || String(a.fullPath).localeCompare(String(b.fullPath)) || byFileAndLine(a, b));

  const impacted = [...depth].map(([id, level]) => {
    const component = components.get(id);
    return {
      name: component?.name ?? id,
      kind: component?.kind ?? null,
      file: component?.file ?? null,
      line: component?.line ?? null,
      depth: level,
      ...(level === 0
        ? { changedThrough: [...changedThrough.get(id)!].sort() }
        : { renders: [...renderedChildren.get(id) ?? []].sort() }),
    };
  }).sort((a, b) => a.depth - b.depth || byFileAndLine(a, b));
  return { components: impacted, pages };
}

// The calls that reach the `routeIds` routes through REQUESTS (every linked
// call without ids), each with the function that makes it, or the file for a
// top-level call, and the components and pages whose code reaches those
// functions (callers followed up to `maxDepth` levels).
export async function apiConsumers(
  engine: IQueryEngine,
  routeIds: readonly string[] | null,
  maxDepth: number,
  functions: Map<string, FunctionInfo>,
  edges: readonly CallEdge[],
) {
  const rows = await engine.query(`
    MATCH (routeFile:File)-[:DECLARES_ROUTE]->(route:Route)<-[request:REQUESTS]-(call:Call)
    WHERE ${routeIds ? "id(route) IN $ids" : "true"}
    OPTIONAL MATCH (fn:Function)-[:CALLS]->(call)
    RETURN id(route) AS route, route.method AS routeMethod, route.fullPath AS routeFullPath,
      route.framework AS routeFramework, routeFile.relativePath AS routeFile, route.line AS routeLine,
      id(call) AS call, call.line AS line, call.expression AS expression, call.httpClient AS client,
      request.method AS method, request.url AS url, request.match AS match, id(fn) AS fn
  `, { ids: routeIds ?? [] }) as Row[];
  const describe = (id: string) => describeFunction(functions.get(id), id);
  const consumers = rows.map((row) => {
    const caller = row.fn == null ? null : describe(String(row.fn));
    return {
      routeId: String(row.route),
      route: { method: str(row.routeMethod), fullPath: str(row.routeFullPath), framework: str(row.routeFramework), file: str(row.routeFile), line: num(row.routeLine) },
      client: str(row.client),
      method: str(row.method),
      url: str(row.url),
      match: str(row.match),
      file: caller?.file ?? callFile(String(row.call)),
      line: num(row.line),
      expression: str(row.expression),
      function: caller?.name ?? null,
      fn: row.fn == null ? null : String(row.fn),
    };
  }).sort((a, b) => String(a.route.fullPath).localeCompare(String(b.route.fullPath)) || String(a.route.method).localeCompare(String(b.route.method)) || byFileAndLine(a, b));

  const callerIds = [...new Set(consumers.flatMap((consumer) => (consumer.fn ? [consumer.fn] : [])))];
  const depth = walkCalls(edges, callerIds, "up", maxDepth);
  const ui = callerIds.length > 0 ? await componentImpact(engine, [...depth.keys()], maxDepth, describe) : { components: [], pages: [] };
  return { consumers, components: ui.components, pages: ui.pages };
}

// The file of a call from its id (`file:<path>:…:call:…`), for calls made
// outside a function.
function callFile(id: string): string | null {
  return /^file:(.+?):(?:call|initializercall|variable|function|class):/u.exec(id)?.[1] ?? null;
}

// A consumer as listed in results, without internal ids.
export function describeConsumer({ routeId: _routeId, fn: _fn, ...consumer }: Awaited<ReturnType<typeof apiConsumers>>["consumers"][number]) {
  return consumer;
}
