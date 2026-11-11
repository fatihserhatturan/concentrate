import type { IQueryEngine } from "../../core/contracts/query-engine.js";
import { optionalString } from "./args.js";
import type { PageWindow } from "./paging.js";

type Row = Record<string, unknown>;

// Routes and entrypoints listed per table; the counts cover all of them.
const USERS_PER_TABLE = 20;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

// list_tables: database tables and collections (from Prisma schemas, TypeORM
// entities, Mongoose schemas, Drizzle tables and Knex calls, and SQL migrations and schema files merged into them by name) with their columns, the models that map to them, those models'
// relations, and the routes and entrypoints that read or write them.
export async function listTables(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const name = optionalString(args.name);
  const library = optionalString(args.library);
  const conditions = [
    name ? "contains(lower(table.name), lower($name))" : null,
    library ? "table.library = $library" : null,
  ].filter(Boolean);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const params = { name: name ?? "", library: library ?? "" };

  const [tables, models, relations, routes, entrypoints, functions] = await Promise.all([
    engine.query(`
      MATCH (table:Table) ${where}
      RETURN id(table) AS id, table.name AS name, table.kind AS kind, table.library AS library,
        table.schemaName AS schemaName, table.provider AS provider, table.declaredIn AS declaredIn,
        table.line AS line, table.columns AS columns, table.migrations AS migrations, table.indexes AS indexes
    `, params),
    engine.query(`
      MATCH (model:DataModel)-[:MAPS_TO_TABLE]->(table:Table) ${where}
      RETURN id(table) AS table, id(model) AS modelId, model.name AS model
    `, params),
    engine.query(`
      MATCH (model:DataModel)-[rel:RELATES_TO]->(target:DataModel)
      RETURN id(model) AS modelId, rel.field AS field, rel.kind AS kind, target.name AS target,
        rel.relationName AS relationName, rel.onDelete AS onDelete
    `),
    engine.query(`
      MATCH (route:Route)-[rel:READS_ROUTE|WRITES_ROUTE]->(table:Table) ${where}
      OPTIONAL MATCH (file:File)-[:DECLARES_ROUTE]->(route)
      RETURN id(table) AS table, id(route) AS id, route.method AS method, route.fullPath AS fullPath,
        route.path AS path, file.relativePath AS file, route.line AS line, label(rel) AS relType, rel.operation AS operation
    `, params),
    engine.query(`
      MATCH (entrypoint:EntryPoint)-[rel:READS_ENTRYPOINT|WRITES_ENTRYPOINT]->(table:Table) ${where}
      OPTIONAL MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entrypoint)
      RETURN id(table) AS table, id(entrypoint) AS id, entrypoint.kind AS kind, entrypoint.trigger AS trigger,
        file.relativePath AS file, entrypoint.line AS line, label(rel) AS relType, rel.operation AS operation
    `, params),
    engine.query(`
      MATCH (fn:Function)-[rel:READS_FUNCTION|WRITES_FUNCTION]->(table:Table) ${where}
      RETURN id(table) AS table, id(fn) AS id, label(rel) AS relType
    `, params),
  ]) as Row[][];

  const relationsByModel = group(relations!, "modelId");
  const modelsByTable = group(models!, "table");
  const routesByTable = users(routes!, (row) => ({
    method: row.method,
    path: row.fullPath ?? row.path,
    file: row.file,
    line: row.line,
  }));
  const entrypointsByTable = users(entrypoints!, (row) => ({
    kind: row.kind,
    trigger: row.trigger,
    file: row.file,
    line: row.line,
  }));
  const functionsByTable = users(functions!, () => ({}));

  const result = tables!
    .map((table) => {
      const id = String(table.id);
      const tableModels = modelsByTable.get(id) ?? [];
      const tableRoutes = routesByTable.get(id) ?? [];
      const tableEntrypoints = entrypointsByTable.get(id) ?? [];
      const tableFunctions = functionsByTable.get(id) ?? [];
      return {
        name: table.name,
        kind: table.kind,
        library: table.library,
        ...(table.schemaName ? { schemaName: table.schemaName } : {}),
        ...(table.provider ? { provider: table.provider } : {}),
        declaredIn: table.declaredIn ?? null,
        line: table.line ?? null,
        columns: columns(table.columns),
        ...(jsonList(table.indexes).length > 0 ? { indexes: jsonList(table.indexes) } : {}),
        ...(jsonList(table.migrations).length > 0 ? { migrations: jsonList(table.migrations) } : {}),
        models: tableModels.map((model) => ({
          name: model.model,
          relations: (relationsByModel.get(String(model.modelId)) ?? [])
            .sort((a, b) => String(a.field).localeCompare(String(b.field)))
            .map((relation) => ({
            field: relation.field,
            kind: relation.kind,
            model: relation.target,
            ...(relation.relationName ? { relationName: relation.relationName } : {}),
            ...(relation.onDelete ? { onDelete: relation.onDelete } : {}),
          })),
        })),
        readBy: counts([tableRoutes, tableEntrypoints, tableFunctions], "reads"),
        writtenBy: counts([tableRoutes, tableEntrypoints, tableFunctions], "writes"),
        routes: tableRoutes.slice(0, USERS_PER_TABLE).map(describeUser),
        entrypoints: tableEntrypoints.slice(0, USERS_PER_TABLE).map(describeUser),
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name))
      || String(a.library).localeCompare(String(b.library))
      || String(a.declaredIn ?? "").localeCompare(String(b.declaredIn ?? "")));

  return {
    query: { name, library },
    totalTables: result.length,
    tables: window.take(result),
    note: `Tables come from Prisma schema files, TypeORM entities, Mongoose schemas, Drizzle table definitions, Knex calls and SQL files (library sql when no code declares the table; migrations lists each file, line and change in run order, 0 for a schema file). readBy / writtenBy count distinct routes, entrypoints and functions; each table lists up to ${USERS_PER_TABLE} routes and entrypoints.`,
  };
}

type User = { info: Row; reads: Set<string>; writes: Set<string> };

// Per table, the distinct sources reading or writing it, in file and line order.
function users(rows: readonly Row[], describe: (row: Row) => Row): Map<string, User[]> {
  const byTable = new Map<string, Map<string, User>>();
  for (const row of rows) {
    const table = String(row.table);
    let sources = byTable.get(table);
    if (!sources) byTable.set(table, sources = new Map());
    const id = String(row.id);
    let user = sources.get(id);
    if (!user) sources.set(id, user = { info: describe(row), reads: new Set(), writes: new Set() });
    const operation = str(row.operation);
    const reads = String(row.relType).startsWith("READS");
    (reads ? user.reads : user.writes).add(operation ?? (reads ? "read" : "write"));
  }
  return new Map([...byTable].map(([table, sources]) => [table, [...sources.values()].sort((a, b) =>
    String(a.info.file ?? "").localeCompare(String(b.info.file ?? "")) || Number(a.info.line ?? 0) - Number(b.info.line ?? 0))]));
}

function describeUser(user: User): Row {
  return {
    ...user.info,
    ...(user.reads.size > 0 ? { reads: [...user.reads].sort() } : {}),
    ...(user.writes.size > 0 ? { writes: [...user.writes].sort() } : {}),
  };
}

function counts([routes, entrypoints, functions]: User[][], access: "reads" | "writes") {
  const count = (list: User[]) => list.filter((user) => user[access].size > 0).length;
  return { routes: count(routes!), entrypoints: count(entrypoints!), functions: count(functions!) };
}

// Column JSON, keeping only the flags that are set and the database name
// when it differs.
function columns(value: unknown): Row[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as Row[];
    return Array.isArray(parsed)
      ? parsed.map((column) => ({
        name: column.name,
        type: column.type,
        ...(column.column !== column.name ? { column: column.column } : {}),
        ...(column.optional ? { optional: true } : {}),
        ...(column.list ? { list: true } : {}),
        ...(column.isId ? { isId: true } : {}),
        ...(column.isUnique ? { isUnique: true } : {}),
        ...(column.references ? { references: column.references } : {}),
      }))
      : [];
  } catch {
    return [];
  }
}

function jsonList(value: unknown): Row[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as Row[] : [];
  } catch {
    return [];
  }
}

function group(rows: readonly Row[], key: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const value = String(row[key]);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  return groups;
}
