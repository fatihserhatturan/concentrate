import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { fileOfNodeId } from "../js-ts/resolution/data-access.js";
import { sqlTableAccesses, type SqlTableAccess } from "../go/sql.js";

// The one place that makes the Table and DataModel nodes and the MAPS_TO_TABLE and ACCESSES_DATA
// relationships of Java data access, so JPA, Spring Data, JDBC and MyBatis meet on the same tables.
//
//   - A Table is `table:java:-:<name>` (`kind: "table"`, `columns`, `declaredIn`, `line`: the shape the Go,
//     Rust and C++ contributors use). One per table name, whatever the case: the spelling that
//     reaches the graph first stays (`Users` then `users` is the one `Users`), so a JPA `@Table(name =
//     "USERS")` and `SELECT … FROM users` are one node, which `sql.schema` then fills with the columns.
//     Quotes and a schema prefix are not part of the name (`"public"."users"` is `users`; the schema is the
//     Table's `schemaName`).
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
const tablesByGraph = new WeakMap<object, Map<string, string>>();

export const javaTableId = (name: string): string => `${TABLE_PREFIX}${name}`;

/** A table name as the SQL layer writes it: no quotes, no schema (`"public"."Users"` is `Users`). */
export function normalizeTableName(raw: string): string {
  const parts = raw.split(".").map((part) => part.trim().replace(/^["`[]|["`\]]$/gu, ""));
  return parts.at(-1) ?? "";
}

// Lower-cased name → Table id of the Java tables the graph already has (another contributor made them).
function knownTables(graph: IGraphContributor): Map<string, string> {
  let known = tablesByGraph.get(graph);
  if (!known) {
    known = new Map();
    for (const node of graph.nodesWithLabel("Table")) {
      if (node.id.startsWith(TABLE_PREFIX)) known.set(String(node.properties.name).toLowerCase(), node.id);
    }
    tablesByGraph.set(graph, known);
  }
  return known;
}

/**
 * The id of the Table of `name`, created on first use. A table that exists keeps its spelling and gets
 * `declaredIn`, `line`, `schemaName` and `columns` from `extra` when it has none (an entity's declaration
 * after a query's mention).
 */
export function javaTable(graph: IGraphContributor, name: string, extra: JavaTableExtra = {}): string {
  const clean = normalizeTableName(name);
  const known = knownTables(graph);
  const key = clean.toLowerCase();
  const existing = known.get(key);
  if (existing) {
    const node = graph.node(existing);
    if (node && extra.declaredIn && (node.properties.declaredIn === null || node.properties.declaredIn === undefined)) {
      Object.assign(node.properties, { library: extra.library ?? node.properties.library, declaredIn: extra.declaredIn, line: extra.line ?? null, columns: JSON.stringify(extra.columns ?? []) });
    }
    if (node && extra.schemaName && (node.properties.schemaName === null || node.properties.schemaName === undefined)) node.properties.schemaName = extra.schemaName;
    return existing;
  }
  const id = javaTableId(clean);
  known.set(key, id);
  graph.addNode({
    id,
    label: "Table",
    properties: {
      name: clean,
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

/** The tables a literal SQL statement reads and writes: `SELECT … JOIN`, `INSERT`, `UPDATE`, `DELETE`, CTEs. */
export function sqlAccesses(sql: string): SqlTableAccess[] {
  return sqlTableAccesses(sql);
}

export type SqlModelAccess = { modelId: string; table: string; operation: JavaDataOperation };

/**
 * For each table a literal SQL statement touches, the DataModel named after it (`datamodel:<library>:<table>`,
 * mapped to the Table) and the operation: what `JdbcTemplate`, `@Query(nativeQuery = true)` and MyBatis
 * statements record.
 */
export function sqlModelAccesses(graph: IGraphContributor, sql: string, library: string): SqlModelAccess[] {
  return sqlTableAccesses(sql).map((access) => {
    const table = javaTable(graph, access.table, { library });
    const name = String(graph.node(table)?.properties.name ?? access.table);
    return { modelId: javaDataModel(graph, { name, library, table }), table, operation: access.operation };
  });
}

/**
 * One access site. `callId`: the Call node of the access (its function is the CALLS caller); `functionId`: the
 * function itself, for an access its declaration is (a Spring Data repository method, a MyBatis mapper
 * method).
 */
export type JavaDataAccess = {
  callId?: string;
  functionId?: string;
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
    for (const relationship of graph.relationshipsOfType(type)) handlers.set(relationship.to, [...handlers.get(relationship.to) ?? [], relationship.from]);
  }
  const callersOf = new Map<string, string[]>();
  for (const relationship of graph.relationshipsOfType("CALL_RESOLVES_TO")) {
    const caller = callerByCall.get(relationship.from);
    if (caller && caller !== relationship.to) callersOf.set(relationship.to, [...callersOf.get(relationship.to) ?? [], caller]);
  }
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
  for (const access of accesses) {
    const site = access.callId ?? access.functionId;
    const functionId = access.functionId ?? (access.callId ? callerByCall.get(access.callId) : undefined);
    if (!site || !functionId) continue;
    if (record(functionId, access, site, true)) byFunction.set(functionId, [...byFunction.get(functionId) ?? [], { access, site }]);
    for (const source of handlers.get(functionId) ?? []) record(source, access, site, false);
  }
  const queue = [...byFunction.keys()];
  while (queue.length > 0) {
    const functionId = queue.shift()!;
    for (const caller of callersOf.get(functionId) ?? []) {
      let changed = false;
      for (const { access, site } of byFunction.get(functionId) ?? []) {
        if (!record(caller, access, site, false)) continue;
        byFunction.set(caller, [...byFunction.get(caller) ?? [], { access, site }]);
        for (const source of handlers.get(caller) ?? []) record(source, access, site, false);
        changed = true;
      }
      if (changed) queue.push(caller);
    }
  }
  graph.addRelationships(added);
}
