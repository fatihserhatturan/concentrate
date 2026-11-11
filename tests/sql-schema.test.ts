import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode } from "../src/core/graph/model.js";
import { SqlSchema, splitStatements } from "../src/integrations/languages/plain/sql-schema.js";

function schemaOf(sql: string): SqlSchema {
  const schema = new SqlSchema();
  for (const statement of splitStatements(sql)) schema.apply(statement, "a.sql", 1);
  return schema;
}

describe("sql statements", () => {
  it("splits on ; outside comments, strings, quoted names and $$ bodies, with lines", () => {
    const statements = splitStatements("-- a; b\nSELECT 'x;y'; /* c; */ SELECT \"a;b\";\nCREATE FUNCTION f() AS $$ x; y $$;\nSELECT 1");
    assert.deepEqual(statements.map((statement) => [statement.line, statement.text]), [
      [2, "SELECT ''"],
      [2, "SELECT \"a;b\""],
      [3, "CREATE FUNCTION f() AS ''"],
      [4, "SELECT 1"],
    ]);
  });

  it("drops the Down half of a goose or sql-migrate file", () => {
    assert.deepEqual(splitStatements("-- +goose Up\nCREATE TABLE a (x int);\n-- +goose Down\nDROP TABLE a;").map((statement) => statement.text), ["CREATE TABLE a (x int)"]);
  });
});

describe("sql schema", () => {
  const columns = (schema: SqlSchema, table: string) => schema.tables.get(table)!.columns.map((column) => `${column.name}:${column.type}${column.optional ? "?" : ""}${column.isId ? " pk" : ""}${column.isUnique ? " unique" : ""}${column.references ? ` -> ${column.references}` : ""}`);

  it("reads columns with types, nullability, keys and references, inline and as table constraints", () => {
    const schema = schemaOf("CREATE TABLE t (id serial primary key, email varchar(20) NOT NULL UNIQUE, o int REFERENCES orgs(id), n numeric(10,2) DEFAULT 0, p int, q int, PRIMARY KEY (p), FOREIGN KEY (q) REFERENCES things (id))");
    assert.deepEqual(columns(schema, "t"), [
      "id:serial pk",
      "email:varchar(20) unique",
      "o:int? -> orgs.id",
      "n:numeric(10,2)?",
      "p:int pk",
      "q:int? -> things.id",
    ]);
  });

  it("applies alters in order: add, rename, retype, drop, constraint, rename table, drop table", () => {
    const schema = schemaOf([
      "CREATE TABLE a (id int)",
      "ALTER TABLE a ADD COLUMN x int NOT NULL, ADD COLUMN y text",
      "ALTER TABLE a RENAME COLUMN y TO z",
      "ALTER TABLE a ALTER COLUMN x TYPE bigint",
      "ALTER TABLE a ALTER COLUMN x DROP NOT NULL",
      "ALTER TABLE a DROP COLUMN id",
      "ALTER TABLE a ADD CONSTRAINT u UNIQUE (z)",
      "ALTER TABLE a RENAME TO b",
      "CREATE TABLE c (id int)",
      "DROP TABLE IF EXISTS c",
    ].join(";\n"));
    assert.deepEqual([...schema.tables.keys()], ["b"]);
    assert.deepEqual(columns(schema, "b"), ["x:bigint?", "z:text? unique"]);
    assert.deepEqual(schema.tables.get("b")!.changes.map((change) => change.change), ["create", "add-column", "add-column", "rename-column", "alter-column", "alter-column", "drop-column", "add-constraint", "rename"]);
  });

  it("records indexes (and forgets dropped ones), views, and ignores names in other case", () => {
    const schema = schemaOf("CREATE TABLE Users (id int); CREATE UNIQUE INDEX i1 ON users (id DESC); CREATE INDEX i2 ON users USING gin (lower(id)); DROP INDEX i2; CREATE MATERIALIZED VIEW v (a, b) AS SELECT 1, 2");
    assert.deepEqual(schema.tables.get("users")!.indexes, [{ name: "i1", columns: ["id"], unique: true }]);
    assert.deepEqual([schema.tables.get("v")!.kind, schema.tables.get("v")!.columns.map((column) => column.name)], ["view", ["a", "b"]]);
  });

  it("handles quoted and schema-qualified names, MySQL backticks and CREATE TABLE AS", () => {
    const schema = schemaOf("CREATE TABLE `shop`.`orders` (`id` int, KEY k (id)); CREATE TABLE \"Public\".\"Mixed Case\" (\"A b\" text); CREATE TABLE snap AS SELECT 1");
    assert.deepEqual([...schema.tables.values()].map((table) => [table.name, table.schemaName, table.columns.map((column) => column.name)]), [
      ["orders", "shop", ["id"]],
      ["Mixed Case", "Public", ["A b"]],
      ["snap", null, []],
    ]);
  });
});

describe("sql migrations in the graph", () => {
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;
  let tables: Map<string, GraphNode[]>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/sql-migrations"), { continueOnError: false });
    tables = new Map();
    for (const node of graph.nodes) {
      if (node.label === "Table") tables.set(String(node.properties.name), [...(tables.get(String(node.properties.name)) ?? []), node]);
    }
  });
  const columnsOf = (name: string) => (JSON.parse(String(tables.get(name)![0]!.properties.columns)) as Array<{ name: string; type: string }>).map((column) => `${column.name}:${column.type}`);
  const changesOf = (name: string) => (JSON.parse(String(tables.get(name)![0]!.properties.migrations)) as Array<{ file: string; line: number; order: number; change: string }>).map((change) => `${change.order} ${change.file}:${change.line} ${change.change}`);

  it("makes a Table per table and view left at the end, with schema files first and migrations by version", () => {
    assert.deepEqual([...tables.keys()].sort(), ["accounts", "active_users", "orders", "organizations", "settings", "users"]);
    assert.deepEqual(columnsOf("users"), ["id:BIGSERIAL", "email:VARCHAR(255)", "org_id:INTEGER", "balance:NUMERIC(10, 2)", "age:BIGINT", "about:TEXT"]);
    assert.equal(tables.get("active_users")![0]!.properties.kind, "view");
    assert.equal(tables.get("users")![0]!.properties.declaredIn, "db/migrations/0001_init.up.sql");
    assert.equal(tables.get("users")![0]!.properties.schemaName, "public");
    // The rename migration (0003) runs after 0002; legacy_audit is dropped in its own file; .down.sql and `-- +goose Down` are not read.
    assert.deepEqual(columnsOf("organizations"), ["id:BIGINT", "name:TEXT"]);
    assert.deepEqual(columnsOf("orders"), ["id:BIGINT", "user_id:BIGINT", "total:DECIMAL(10,2)"]);
    assert.equal(tables.has("legacy_audit"), false);
    assert.equal(tables.has("scratch"), false);
  });

  it("records the ordered changes of each table", () => {
    assert.deepEqual(changesOf("users"), [
      "1 db/migrations/0001_init.up.sql:1 create",
      "1 db/migrations/0001_init.up.sql:14 create-index",
      "2 db/migrations/0002_profile.up.sql:1 add-column",
      "2 db/migrations/0002_profile.up.sql:1 add-column",
      "2 db/migrations/0002_profile.up.sql:2 rename-column",
      "2 db/migrations/0002_profile.up.sql:3 alter-column",
      "2 db/migrations/0002_profile.up.sql:4 add-constraint",
    ]);
    assert.deepEqual(changesOf("organizations").map((entry) => entry.replace(/^\d+ /u, "")), [
      "db/migrations/0001_init.up.sql:8 create",
      "db/migrations/0003_rename.up.sql:1 rename",
    ]);
    assert.deepEqual(changesOf("settings"), ["0 db/dumps/schema.sql:2 create"]);
  });

  it("merges into the table a Prisma schema declares: one node, the model's columns kept, the SQL ones added", () => {
    assert.equal(tables.get("accounts")!.length, 1);
    const account = tables.get("accounts")![0]!;
    assert.equal(account.properties.library, "prisma");
    assert.equal(account.properties.declaredIn, "prisma/schema.prisma");
    assert.deepEqual(columnsOf("accounts"), ["id:Int", "email:String", "created_at:TIMESTAMP(3)", "slug:TEXT"]);
    assert.deepEqual(changesOf("accounts").map((entry) => entry.replace(/^\d+ /u, "")), [
      "prisma/migrations/20240101000000_init/migration.sql:2 create",
      "prisma/migrations/20240101000000_init/migration.sql:11 create-index",
      "prisma/migrations/20240215101500_add_slug/migration.sql:2 add-column",
    ]);
  });
});
