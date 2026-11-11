import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { MAX_PARSED_BYTES } from "../../languages/plain/parser.js";
import { SqlSchema, splitStatements, type SqlColumn, type SqlTable } from "../../languages/plain/sql-schema.js";

// SQL migrations and schema files as `Table` nodes. Every `.sql` file is read
// in order (schema and dump files first, then migrations by their version:
// `0001_x.sql`, `20240101120000_x.up.sql`, Flyway's `V3__x.sql`, Prisma's
// `migrations/<version>_<name>/migration.sql`; `.down.sql` files and the
// `-- +goose Down` half are the undo and are skipped) and applied to one
// schema: `CREATE TABLE`, `ALTER TABLE` (add, drop, rename and alter a column,
// add a constraint), `CREATE VIEW`, `CREATE INDEX` and the drops and renames
// that undo them. What stands at the end becomes a Table (`library: sql`,
// `declaredIn` the file that created it) with its columns, indexes and the
// ordered changes (`migrations`). A table the code already declares (an ORM
// model, a Prisma schema, a query string) with the same name, in any case,
// is not duplicated: it gets the SQL columns it lacks, its `declaredIn` when
// it had none, and the same `migrations` and `indexes`.

export type MigrationChange = { file: string; line: number; order: number; change: string };

function isDown(relative: string): boolean {
  return /(?:^|[._/-])down\.sql$/iu.test(relative) || /(?:^|\/)down\//iu.test(relative);
}

function isMigration(relative: string): boolean {
  const base = path.posix.basename(relative);
  return /(?:^|\/)(?:migrat\w*)\//iu.test(relative) || /^(?:\d{3,}|V\d+__|\d{8,})/iu.test(base);
}

// The version a migration file runs at: the leading digits of its name, or of
// its folder for Prisma's `migration.sql`.
function version(relative: string): bigint | null {
  const base = path.posix.basename(relative);
  const source = /^migration\.sql$/iu.test(base) ? path.posix.basename(path.posix.dirname(relative)) : base;
  const digits = /^[Vv]?(\d+)/u.exec(source)?.[1];
  return digits ? BigInt(digits) : null;
}

export const sqlSchemaContributor: ISemanticContributor = {
  async contribute(graph, rootPath, _report, files) {
    const sqlFiles: Array<{ absolute: string; relative: string }> = [];
    const known = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
      if (node.label === "File" && node.properties.language === "sql" && typeof node.properties.relativePath === "string") {
        known.set(node.properties.relativePath.split(path.sep).join("/"), node);
      }
    }
    for (const file of files) {
      const relative = path.relative(rootPath, file).split(path.sep).join("/");
      if (known.has(relative) && !isDown(relative)) sqlFiles.push({ absolute: file, relative });
    }
    if (sqlFiles.length === 0) return;

    // Schema and dump files first, then the migrations by version.
    const schemaFiles = sqlFiles.filter((file) => !isMigration(file.relative)).sort((a, b) => a.relative.localeCompare(b.relative));
    const migrations = sqlFiles.filter((file) => isMigration(file.relative)).sort((a, b) => {
      const left = version(a.relative);
      const right = version(b.relative);
      if (left !== null && right !== null && left !== right) return left < right ? -1 : 1;
      if ((left === null) !== (right === null)) return left === null ? 1 : -1;
      return a.relative.localeCompare(b.relative);
    });

    const schema = new SqlSchema();
    let order = 0;
    for (const [group, list] of [[false, schemaFiles], [true, migrations]] as const) {
      for (const file of list) {
        if (group) order += 1;
        const info = await stat(file.absolute).catch(() => null);
        if (!info || info.size > MAX_PARSED_BYTES) continue;
        const text = await readFile(file.absolute, "utf8").catch(() => null);
        if (text === null) continue;
        for (const statement of splitStatements(text)) schema.apply(statement, file.relative, group ? order : 0);
      }
    }
    if (schema.tables.size === 0) return;

    const codeTables = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) {
      if (node.label !== "Table" || (node.properties.kind !== "table" && node.properties.kind !== "view")) continue;
      const key = String(node.properties.name).toLowerCase();
      codeTables.set(key, [...(codeTables.get(key) ?? []), node]);
    }

    for (const table of schema.tables.values()) {
      const existing = codeTables.get(table.name.toLowerCase());
      if (existing && existing.length > 0) {
        for (const node of existing) enrich(node, table);
        continue;
      }
      graph.addNode({
        id: `table:sql:-:${table.name}`,
        label: "Table",
        properties: {
          name: table.name,
          kind: table.kind,
          library: "sql",
          schemaName: table.schemaName,
          provider: null,
          declaredIn: table.file,
          line: table.line,
          columns: JSON.stringify(table.columns.map(describeColumn)),
          migrations: JSON.stringify(table.changes),
          indexes: JSON.stringify(table.indexes),
        },
      });
    }
  },
};

function describeColumn(column: SqlColumn) {
  return {
    name: column.name,
    column: column.name,
    type: column.type,
    optional: column.optional,
    list: false,
    isId: column.isId,
    isUnique: column.isUnique,
    ...(column.references ? { references: column.references } : {}),
  };
}

// A table the code declares gets what the SQL adds, never loses what it has.
function enrich(node: GraphNode, table: SqlTable): void {
  let columns: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(String(node.properties.columns ?? "[]")) as unknown;
    if (Array.isArray(parsed)) columns = parsed as Array<Record<string, unknown>>;
  } catch {
    columns = [];
  }
  const names = new Set(columns.flatMap((column) => [String(column.name).toLowerCase(), String(column.column ?? column.name).toLowerCase()]));
  for (const column of table.columns) {
    if (!names.has(column.name.toLowerCase())) columns.push({ ...describeColumn(column) });
  }
  node.properties.columns = JSON.stringify(columns);
  if (node.properties.declaredIn === null || node.properties.declaredIn === undefined) {
    node.properties.declaredIn = table.file;
    node.properties.line = table.line;
  }
  if (node.properties.schemaName === null || node.properties.schemaName === undefined) node.properties.schemaName = table.schemaName;
  node.properties.migrations = JSON.stringify(table.changes);
  node.properties.indexes = JSON.stringify(table.indexes);
}
