import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import {
  javaDataModel,
  normalizeTableName,
  recordJavaDataAccesses,
  sqlAccesses,
  tableModelWithPrefix,
  tableWithPrefix,
  type JavaDataAccess,
  type JavaDataModelInput,
  type JavaDataOperation,
  type JavaTableExtra,
  type SqlModelAccess,
} from "../java/data-shared.js";

// The one place that makes the Table and DataModel nodes and the MAPS_TO_TABLE and ACCESSES_DATA relationships of
// C# data access, so EF Core, Dapper and ADO.NET meet on the same tables. It is Java's `data-shared.ts` with the
// C# Table prefix (the shapes, the rules and the SQL reader are the same, so `js-ts.data-access` turns the accesses
// into READS / WRITES and `sql.schema` fills the columns exactly as for Java):
//
//   - A Table is `table:csharp:-:<lower-cased name>` (`kind: "table"`, `library`, `schemaName`, `provider`, `declaredIn`,
//     `line`, `columns`). One per table name whatever the case: `[Table("Users")]` and `SELECT ... FROM users` are one
//     node. Quotes, brackets and a schema prefix are not part of the name (`[dbo].[Users]` is `Users`). The schema is the
//     Table's `schemaName` of its first declaration, never of a SQL mention: two schemas with one name are one Table. A declaration (an entity, `[Table]`, `ToTable`) gives the display name and `declaredIn`;
//     a mention (a query) only creates the table when it is the first.
//   - A DataModel (`name`, `library`, `declaredIn`, `line`) is the entity (`efcore`), or the table-named stand-in of a
//     library (`dapper`, `ado.net`, `efcore` for raw SQL) for tables named only by literal SQL
//     (`datamodel:<library>:<lower-cased table>`); `MAPS_TO_TABLE` ties it to its table.
//   - ACCESSES_DATA goes from the Function that makes the access to the DataModel with `operation` (`read`, `create`,
//     `update`, `delete`, `upsert`, `aggregate`), `library`, `line`, `expression`, `file` and `direct`; from its routes
//     and entrypoints and from every Function that calls it (transitively, CALL_RESOLVES_TO) with `direct: false`.
//
// A track creates its nodes through `csharpTable` and `csharpDataModel`, finds the tables of a literal SQL string with
// `csharpSqlModelAccesses`, and records the accesses with `recordCSharpDataAccesses` once.

export type CSharpDataOperation = JavaDataOperation;
export type CSharpTableExtra = JavaTableExtra;
export type CSharpDataModelInput = JavaDataModelInput;
export type CSharpDataAccess = JavaDataAccess;
export type CSharpSqlModelAccess = SqlModelAccess;

/** Prefix of every C# Table id. */
export const CSHARP_TABLE_PREFIX = "table:csharp:-:";

/** `csharpTable`'s id for a table name (the same normalisation: no quotes, no schema, lower case). */
export const csharpTableId = (name: string): string => `${CSHARP_TABLE_PREFIX}${normalizeTableName(name).toLowerCase()}`;

/** The id of the Table of `name`, created on first use (see `javaTable` in the Java data layer for the declaration rules). */
export const csharpTable = (graph: IGraphContributor, name: string, extra: CSharpTableExtra = {}): string => tableWithPrefix(graph, CSHARP_TABLE_PREFIX, name, extra);

/** The id of the DataModel, created on first use, with `MAPS_TO_TABLE` to its table (`datamodel:<library>:<scope>:<name>`). */
export const csharpDataModel = (graph: IGraphContributor, input: CSharpDataModelInput): string => javaDataModel(graph, input);

/** The stand-in DataModel of a library for a table (`datamodel:<library>:<lower-cased name>`), created on first use. */
export const csharpTableModel = (graph: IGraphContributor, table: string, library: string): string => tableModelWithPrefix(graph, table, library, CSHARP_TABLE_PREFIX);

/** The tables a literal SQL statement reads and writes (T-SQL brackets, `dbo.` schemas, `TOP`, hints, CTEs; a sole `COUNT(*)` is `aggregate`). */
export const csharpSqlAccesses = (sql: string): Array<{ table: string; operation: CSharpDataOperation }> => sqlAccesses(sql);

/**
 * For each table a literal SQL statement touches, the stand-in DataModel of `library` (mapped to the C# Table) and the
 * operation: what Dapper, ADO.NET and `FromSqlRaw` / `ExecuteSqlRaw` record.
 */
export function csharpSqlModelAccesses(graph: IGraphContributor, sql: string, library: string): CSharpSqlModelAccess[] {
  return sqlAccesses(sql).map((access) => {
    const table = csharpTable(graph, access.table, { library });
    return { modelId: csharpTableModel(graph, table, library), table, operation: access.operation };
  });
}

/**
 * Adds ACCESSES_DATA for every access (`callId`: the Call node whose caller makes it; `functionId`: the function itself),
 * from its function (`direct: true`), the routes and entrypoints it handles and the functions that call it, transitively.
 */
export const recordCSharpDataAccesses = (graph: IGraphContributor, accesses: readonly CSharpDataAccess[]): void => recordJavaDataAccesses(graph, accesses);
