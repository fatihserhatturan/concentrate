import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

describe("SQL tables in list_tables", () => {
  let store: GraphStore;
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-sql-"));
    const graph = await buildCodeGraph(path.resolve("fixtures/sql-migrations"), { continueOnError: false });
    store = await GraphStore.open(path.join(root, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (args: Record<string, unknown>): Promise<Record<string, any>> =>
    JSON.parse((await callMcpTool(store, "list_tables", args)).content[0]!.text) as Record<string, any>;

  it("lists SQL-only tables with columns, references, indexes and the ordered migrations", async () => {
    const result = await call({ library: "sql", name: "users" });
    // The name is a substring: the active_users view comes too.
    assert.deepEqual(result.tables.map((table: any) => [table.name, table.kind]), [["active_users", "view"], ["users", "table"]]);
    const users = result.tables.find((table: any) => table.name === "users");
    assert.deepEqual(users.columns.find((column: any) => column.name === "org_id"), { name: "org_id", type: "INTEGER", optional: true, references: "orgs.id" });
    assert.deepEqual(users.indexes, [{ name: "idx_users_org", columns: ["org_id"], unique: false }]);
    assert.deepEqual(users.migrations.map((change: any) => `${change.order} ${change.change}`), ["1 create", "1 create-index", "2 add-column", "2 add-column", "2 rename-column", "2 alter-column", "2 add-constraint"]);
  });

  it("shows the Prisma table with the migrations merged into it, not a second table", async () => {
    const result = await call({ name: "accounts" });
    assert.equal(result.totalTables, 1);
    assert.equal(result.tables[0].library, "prisma");
    assert.deepEqual(result.tables[0].columns.map((column: any) => column.name), ["id", "email", "created_at", "slug"]);
    assert.equal(result.tables[0].migrations.length, 3);
  });
});
