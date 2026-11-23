import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { fileOfNodeId } from "../js-ts/resolution/data-access.js";
import { sqlTableAccesses, type SqlTableAccess } from "../go/sql.js";

// The one place that makes the Table and DataModel nodes and the MAPS_TO_TABLE and ACCESSES_DATA
// relationships of Java data access, so JPA, Spring Data, JDBC and MyBatis meet on the same tables.
//
//   - A Table is `table:java:-:<name>` with the lower-cased name (`kind: "table"`, `columns`, `declaredIn`,
//     `line`: the shape the Go, Rust and C++ contributors use). One per table name, whatever the case, so a JPA
//     `@Table(name = "USERS")` and `SELECT … FROM users` are one node, which `sql.schema` then fills with the
//     columns. Its `name` is the spelling of a declaration (a JPA entity or `@Table`; of several, the smallest
//     spelling, then the first by file and line) when there is one, else the lower-cased name: nothing depends on the order the files
//     were read in. Quotes and a schema prefix are not part of the name (`"public"."users"` is `users`; the
//     schema is the Table's `schemaName`; one table name in two schemas is one Table, the first schema stays).
//   - A DataModel (`name`, `library`, `declaredIn`, `line`) is the entity, mapper or table-named stand-in
//     of a library (`jpa`, `spring-data`, `jdbc`, `mybatis`); `MAPS_TO_TABLE` ties it to its table. A
//     model whose table is only named by literal SQL (`sqlModelAccesses`) is `datamodel:<library>:<table>`.
//   - ACCESSES_DATA goes from the function that makes the access to the DataModel with `operation`
//     (`read`, `create`, `update`, `delete`, `upsert`, `aggregate`), `library`, `line`, `expression`, `file`
//     and `direct`; from its routes and entrypoints, and from every function that calls it (transitively,
//     through CALL_RESOLVES_TO), with `direct: false`. `dataAccessContributor` (js-ts.data-access) then
//     turns each access whose model has a table into READS / WRITES to it, so the data contributors
//     of Java run before it.
// A track creates its nodes through `javaTable` and `javaDataModel`, finds the tables of a literal SQL
// string with `sqlModelAccesses` (the same SQL reader as Go, Python and Rust), and records the accesses
// with `recordJavaDataAccesses` once.

export type JavaDataOperation = "read" | "create" | "update" | "delete" | "upsert" | "aggregate";

export type JavaTableExtra = {
  library?: string;
  schemaName?: string | null;
  declaredIn?: string | null;
  line?: number | null;
  columns?: ReadonlyArray<Record<string, unknown>>;
};

const TABLE_PREFIX = "table:java:-:";
// Per graph, per language prefix: lower-cased name -> Table id.
const tablesByGraph = new WeakMap<object, Map<string, Map<string, string>>>();

export const javaTableId = (name: string): string => `${TABLE_PREFIX}${name.toLowerCase()}`;

/** A table name as the SQL layer writes it: no quotes, no schema (`"public"."Users"` is `Users`). */
export function normalizeTableName(raw: string): string {
  const parts = raw.split(".").map((part) => part.trim().replace(/^["`[]|["`\]]$/gu, ""));
  return parts.at(-1) ?? "";
}

// Lower-cased name → Table id of the tables of one language (`prefix`) the graph already has (another contributor made them).
function knownTables(graph: IGraphContributor, prefix: string): Map<string, string> {
  let byPrefix = tablesByGraph.get(graph);
  if (!byPrefix) tablesByGraph.set(graph, (byPrefix = new Map()));
  let known = byPrefix.get(prefix);
  if (!known) {
    known = new Map();
    for (const node of graph.nodesWithLabel("Table")) {
      if (node.id.startsWith(prefix)) known.set(node.id.slice(prefix.length), node.id);
    }
    byPrefix.set(prefix, known);
  }
  return known;
}

/**
 * The id of the Table of `name`, created on first use. `name` is the display spelling only when `extra.declaredIn`
 * is given (a declaration); of several, the smallest spelling wins (then the first by file and line), and brings its `library`, `line` and
 * `columns`. A mention (a query) fills in `schemaName` when the table has none.
 */
export function javaTable(graph: IGraphContributor, name: string, extra: JavaTableExtra = {}): string {
  return tableWithPrefix(graph, TABLE_PREFIX, name, extra);
}

/** `javaTable` for another language: its Table ids are `<prefix><lower-cased name>` (C#: `table:csharp:-:`). */
export function tableWithPrefix(graph: IGraphContributor, prefix: string, name: string, extra: JavaTableExtra = {}): string {
  const clean = normalizeTableName(name);
  const known = knownTables(graph, prefix);
  const key = clean.toLowerCase();
  const existing = known.get(key);
  if (existing) {
    const node = graph.node(existing);
    if (node && extra.declaredIn) {
      const current = node.properties.declaredIn;
      const spelling = String(node.properties.name);
      const earlier = typeof current !== "string" || clean < spelling || (clean === spelling && (extra.declaredIn < current || (extra.declaredIn === current && (extra.line ?? 0) < Number(node.properties.line ?? 0))));
      if (earlier) Object.assign(node.properties, { name: clean, library: extra.library ?? node.properties.library, declaredIn: extra.declaredIn, line: extra.line ?? null, columns: JSON.stringify(extra.columns ?? []) });
    }
    if (node && extra.schemaName && (node.properties.schemaName === null || node.properties.schemaName === undefined)) node.properties.schemaName = extra.schemaName;
    return existing;
  }
  const id = `${prefix}${key}`;
  known.set(key, id);
  graph.addNode({
    id,
    label: "Table",
    properties: {
      name: extra.declaredIn ? clean : key,
      kind: "table",
      library: extra.library ?? "sql",
      schemaName: extra.schemaName ?? null,
      provider: null,
      declaredIn: extra.declaredIn ?? null,
      line: extra.line ?? null,
      columns: JSON.stringify(extra.columns ?? []),
    },
  });
  return id;
}

/** `datamodel:<library>:<scope>:<name>`; `scope` (a package or directory) keeps same-named entities apart, `datamodel:<library>:<name>` without. */
export const javaDataModelId = (library: string, name: string, scope?: string): string => (scope ? `datamodel:${library}:${scope}:${name}` : `datamodel:${library}:${name}`);

export type JavaDataModelInput = {
  name: string;
  library: string;
  /** Default `javaDataModelId(library, name, scope)`. */
  id?: string;
  scope?: string;
  declaredIn?: string | null;
  line?: number | null;
  /** The Table id (`javaTable`) the model maps to; no MAPS_TO_TABLE when absent. */
  table?: string;
};

/** The id of the DataModel, created on first use, with `MAPS_TO_TABLE` to its table. */
export function javaDataModel(graph: IGraphContributor, input: JavaDataModelInput): string {
  const id = input.id ?? javaDataModelId(input.library, input.name, input.scope);
  if (graph.node(id)) return id;
  const properties: GraphNode["properties"] = { name: input.name, library: input.library };
  if (input.declaredIn !== undefined) properties.declaredIn = input.declaredIn;
  if (input.line !== undefined) properties.line = input.line;
  graph.addNode({ id, label: "DataModel", properties });
  if (input.table) graph.addRelationship({ from: id, to: input.table, type: "MAPS_TO_TABLE", properties: {} });
  return id;
}

/** The stand-in DataModel of a library for a table (`datamodel:<library>:<lower-cased name>`), created on first use. */
export function javaTableModel(graph: IGraphContributor, table: string, library: string): string {
  return tableModelWithPrefix(graph, table, library, TABLE_PREFIX);
}

/** `javaTableModel` for a table made with `tableWithPrefix(…, prefix, …)`. */
export function tableModelWithPrefix(graph: IGraphContributor, table: string, library: string, prefix: string): string {
  const name = String(graph.node(table)?.properties.name ?? table.slice(prefix.length));
  return javaDataModel(graph, { name, library, id: javaDataModelId(library, name.toLowerCase()), table });
}

/** The tables a literal SQL statement reads and writes: `SELECT … JOIN`, `INSERT`, `UPDATE`, `DELETE`, CTEs. */
export function sqlAccesses(sql: string): Array<{ table: string; operation: JavaDataOperation }> {
  const accesses = sqlTableAccesses(sql);
  // `SELECT COUNT(*) FROM t …` aggregates (JDBC, MyBatis, native `@Query`), as JPQL's `SELECT COUNT(x) FROM T` does. With
  // several tables (a join, a subquery) which of them the aggregate runs over is unknown: they stay reads.
  const aggregate = accesses.length === 1 && accesses[0]!.operation === "read" && aggregateSelect.test(sql);
  return aggregate ? accesses.map((access) => ({ ...access, operation: "aggregate" as JavaDataOperation })) : accesses;
}

export type SqlModelAccess = { modelId: string; table: string; operation: JavaDataOperation };

/**
 * For each table a literal SQL statement touches, the DataModel named after it (`datamodel:<library>:<table>`,
 * mapped to the Table) and the operation: what `JdbcTemplate`, `@Query(nativeQuery = true)` and MyBatis
 * statements record.
 */
export function sqlModelAccesses(graph: IGraphContributor, sql: string, library: string): SqlModelAccess[] {
  const accesses = sqlAccesses(sql);
  return accesses.map((access) => {
    const table = javaTable(graph, access.table, { library });
    return { modelId: javaTableModel(graph, table, library), table, operation: access.operation };
  });
}

// A select list of aggregate functions only: `COUNT(*)`, `COUNT(DISTINCT id) AS n`, `MAX(a), MIN(a)`.
const aggregateFunction = String.raw`(?:count|sum|avg|min|max)\s*\((?:[^()]|\([^()]*\))*\)(?:\s+(?:as\s+)?[\w$"]+)?`;
const aggregateSelect = new RegExp(String.raw`^\s*select\s+${aggregateFunction}(?:\s*,\s*${aggregateFunction})*\s+from\b`, "iu");

/**
 * One access site. `callId`: the Call node of the access (its function is the CALLS caller); `functionId`: the
 * function itself, for an access its declaration is (a Spring Data repository method, a MyBatis mapper
 * method).
 */
export type JavaDataAccess = {
  callId?: string;
  functionId?: string;
  /** Column (0-based) of the access, when the line alone cannot tell two lambdas of one line apart. */
  column?: number;
  modelId: string;
  operation: JavaDataOperation;
  library: string;
  line: unknown;
  expression: unknown;
};

/**
 * Adds ACCESSES_DATA for every access: from its function (`direct: true`), the routes and entrypoints the
 * function handles, and the functions that call it, transitively (`direct: false`, with the access's own
 * `line` and `expression` and `file` of the access site).
 */
export function recordJavaDataAccesses(graph: IGraphContributor, accesses: readonly JavaDataAccess[]): void {
  if (accesses.length === 0) return;
  const callerByCall = new Map<string, string>();
  for (const relationship of graph.relationshipsOfType("CALLS")) callerByCall.set(relationship.to, relationship.from);
  const handlers = new Map<string, string[]>();
  for (const type of ["ROUTE_HANDLED_BY", "ENTRYPOINT_HANDLED_BY"] as const) {
    for (const relationship of graph.relationshipsOfType(type)) {
      const list = handlers.get(relationship.to);
      if (list) list.push(relationship.from);
      else handlers.set(relationship.to, [relationship.from]);
    }
  }
  const callersOf = new Map<string, Array<{ caller: string; line: number | undefined; column: number | undefined }>>();
  for (const relationship of graph.relationshipsOfType("CALL_RESOLVES_TO")) {
    const caller = callerByCall.get(relationship.from);
    if (!caller || caller === relationship.to) continue;
    const callLine = graph.node(relationship.from)?.properties.line;
    const callColumn = graph.node(relationship.from)?.properties.columnNumber;
    const entry = { caller, line: typeof callLine === "number" ? callLine : undefined, column: typeof callColumn === "number" ? callColumn : undefined };
    const list = callersOf.get(relationship.to);
    if (list) list.push(entry);
    else callersOf.set(relationship.to, [entry]);
  }
  // A minimal-API lambda handler is part of its enclosing function (`<top-level>`): a Route with `handlerEndLine` only
  // reaches what is called between its own line and that end; an entrypoint of the function does not run the lambdas.
  // `handlerStartLine` / `handlerStartColumn` / `handlerEndColumn` (C# Routes) narrow the range to the handler's own syntax:
  // a local function handler, or two lambdas on one line. Without them the range is the Route's `line` to `handlerEndLine`.
  type Range = { start: number; end: number; startColumn?: number; endColumn?: number };
  const lambdaRange = (source: string): Range | null => {
    const properties = graph.node(source)?.properties;
    if (!properties || typeof properties.handlerEndLine !== "number") return null;
    const start = typeof properties.handlerStartLine === "number" ? properties.handlerStartLine : properties.line;
    if (typeof start !== "number") return null;
    return {
      start,
      end: properties.handlerEndLine,
      ...(typeof properties.handlerStartColumn === "number" ? { startColumn: properties.handlerStartColumn } : {}),
      ...(typeof properties.handlerEndColumn === "number" ? { endColumn: properties.handlerEndColumn } : {}),
    };
  };
  const inside = (range: Range, line: number, column: number | undefined): boolean => {
    if (line < range.start || line > range.end) return false;
    if (column === undefined) return true;
    if (line === range.start && range.startColumn !== undefined && column < range.startColumn) return false;
    if (line === range.end && range.endColumn !== undefined && column > range.endColumn) return false;
    return true;
  };
  const reaches = (source: string, host: string, line: number | undefined, column?: number): boolean => {
    if (line === undefined) return true;
    const own = lambdaRange(source);
    if (own) return inside(own, line, column);
    if (graph.node(source)?.label === "Route") return true;
    return !(handlers.get(host) ?? []).some((other) => {
      const range = lambdaRange(other);
      return range !== null && inside(range, line, column);
    });
  };
  const columnOfCall = (callId: string): number | undefined => {
    const column = graph.node(callId)?.properties.columnNumber;
    return typeof column === "number" ? column : undefined;
  };
  const filePaths = new Set(graph.nodesWithLabel("File").flatMap((node) => (typeof node.properties.relativePath === "string" ? [node.properties.relativePath] : [])));

  const added: GraphRelationship[] = [];
  const seen = new Set<string>();
  // `direct`: the function makes the access; its routes, entrypoints and callers reach it.
  const record = (from: string, access: JavaDataAccess, site: string, direct: boolean): boolean => {
    const key = `${from}\0${access.modelId}\0${access.operation}\0${access.library}\0${String(access.line)}\0${String(access.expression)}\0${site}`;
    if (seen.has(key)) return false;
    seen.add(key);
    added.push({
      from,
      to: access.modelId,
      type: "ACCESSES_DATA",
      properties: { operation: access.operation, library: access.library, line: access.line as number, expression: access.expression as string, file: fileOfNodeId(site, filePaths), direct },
    });
    return true;
  };

  const byFunction = new Map<string, Array<{ access: JavaDataAccess; site: string }>>();
  const push = (functionId: string, entry: { access: JavaDataAccess; site: string }): void => {
    const list = byFunction.get(functionId);
    if (list) list.push(entry);
    else byFunction.set(functionId, [entry]);
  };
  for (const access of accesses) {
    const site = access.callId ?? access.functionId;
    const functionId = access.functionId ?? (access.callId ? callerByCall.get(access.callId) : undefined);
    if (!site || !functionId) continue;
    if (record(functionId, access, site, true)) push(functionId, { access, site });
    const accessLine = typeof access.line === "number" ? access.line : undefined;
    const accessColumn = access.column ?? (access.callId ? columnOfCall(access.callId) : undefined);
    for (const source of handlers.get(functionId) ?? []) if (reaches(source, functionId, accessLine, accessColumn)) record(source, access, site, false);
  }
  const queue = [...byFunction.keys()];
  for (let head = 0; head < queue.length; head += 1) {
    const functionId = queue[head]!;
    for (const { caller, line, column } of callersOf.get(functionId) ?? []) {
      let changed = false;
      for (const { access, site } of byFunction.get(functionId) ?? []) {
        const isNew = record(caller, access, site, false);
        if (isNew) push(caller, { access, site });
        for (const source of handlers.get(caller) ?? []) if (reaches(source, caller, line, column)) record(source, access, site, false);
        if (isNew) changed = true;
      }
      if (changed) queue.push(caller);
    }
  }
  graph.addRelationships(added);
}
