import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { gormTableName } from "../src/integrations/frameworks/go/data-access.js";
import { sqlTableAccesses } from "../src/integrations/frameworks/go/sql.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

// [function, operation, model, library] for each access a call in the
// function's own body makes.
function accesses(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const own = new Set(graph.relationships.filter((rel) => rel.type === "CALLS").map((rel) => {
    const call = byId.get(rel.to)!;
    return `${rel.from}\0${call.properties.line}\0${call.properties.expression}`;
  }));
  return graph.relationships
    .filter((rel) => rel.type === "ACCESSES_DATA" && byId.get(rel.from)?.label === "Function" && own.has(`${rel.from}\0${rel.properties.line}\0${rel.properties.expression}`))
    .map((rel) => `${byId.get(rel.from)!.properties.name} ${rel.properties.operation} ${byId.get(rel.to)!.properties.name} ${rel.properties.library}`)
    .sort();
}

function tablesOf(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "MAPS_TO_TABLE" && typeof byId.get(rel.from)?.properties.declaredIn === "string")
    .map((rel) => `${byId.get(rel.from)!.properties.name}=${byId.get(rel.to)!.properties.name}`)
    .sort();
}

async function withStore<T>(graph: Graph, run: (tool: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>) => Promise<T>): Promise<T> {
  const store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-go-data-")), "graph"));
  try {
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
    return await run(async (name, args) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>);
  } finally {
    await store.close();
  }
}

describe("Go gorm data access", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-gorm"), { continueOnError: false });
  });

  it("finds the model of each chain and the models Preload and Association reach", () => {
    assert.deepEqual(accesses(graph), [
      // Exec / Raw SQL: tables, a gorm model's table as its model.
      "Archive create archived_posts gorm",
      "Archive create audit_log gorm",
      "Archive read Post gorm",
      // Model(&X{}) on a struct field's *gorm.DB.
      "CountPosts read Post gorm",
      // A package variable's *gorm.DB and a Where condition's struct.
      "DeleteCategory delete Category gorm",
      "Popular read Tag gorm",
      "Popular read post_tags gorm",
      // Preload("Writer"), Preload("Tags").
      "Posts read Author gorm",
      "Posts read Post gorm",
      "Posts read Tag gorm",
      // tx := s.db.Begin(); tx.Create(post).
      "Publish create Post gorm",
      "RenameAuthor update Author gorm",
      // Association("Tags").Replace.
      "Retag update Tag gorm",
    ]);
  });

  it("names tables the way gorm does, or by TableName()", () => {
    assert.deepEqual(tablesOf(graph), ["Author=authors", "Category=post_categories", "Post=posts", "Tag=tags"]);
    assert.equal(gormTableName("ArticleUserModel"), "article_user_models");
    assert.equal(gormTableName("HTTPProxy"), "http_proxies");
    assert.equal(gormTableName("Person"), "people");
  });

  it("links model structs with RELATES_TO from their fields and tags", () => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const relations = graph.relationships
      .filter((rel) => rel.type === "RELATES_TO")
      .map((rel) => [byId.get(rel.from)!.properties.name, rel.properties.field, rel.properties.kind, byId.get(rel.to)!.properties.name, rel.properties.fields, rel.properties.relationName, rel.properties.onDelete])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
    assert.deepEqual(relations, [
      ["Author", "Posts", "many", "Post", "[\"WriterID\"]", null, null],
      ["Post", "Tags", "many", "Tag", "[]", "post_tags", "CASCADE"],
      ["Post", "Writer", "one", "Author", "[\"WriterID\"]", null, null],
    ]);
    assert.ok(graph.nodes.every((node) => !Object.keys(node.properties).some((key) => ["goDataAccess", "goGorm", "goLocalType", "goTableName", "goVarRoot"].includes(key))));
  });

  it("answers list_tables, list_data_access, route_details and impact_of", async () => {
    await withStore(graph, async (tool) => {
      const tables = await tool("list_tables", { name: "post_categories" });
      assert.deepEqual(tables.tables[0].routes.map((route: any) => `${route.method} ${route.path}`), ["DELETE /categories/:slug"]);
      const access = await tool("list_data_access", { model: "Post", operation: "read" });
      assert.ok(access.dataAccess.some((row: any) => row.sourceKind === "Route" && row.sourceName === "/posts/count"));
      const route = await tool("route_details", { method: "DELETE", path: "/categories/:slug" });
      assert.deepEqual(route.routes[0].tables.map((table: any) => [table.table, table.writes]), [["post_categories", ["delete"]]]);
      const impact = await tool("impact_of", { symbol: "RenameAuthor" });
      assert.deepEqual(impact.tables.map((table: any) => [table.table, table.writes]), [["authors", ["update"]]]);
    });
  });
});

describe("Go database/sql and sqlx data access", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-sql"), { continueOnError: false });
  });

  it("reads the tables of literal SQL, constants included, and skips dynamic SQL", () => {
    assert.deepEqual(accesses(graph), [
      "Add create orders sqlx",
      "Find read users database/sql",
      "ForUser read orders sqlx",
      "ForUser read users sqlx",
      "Purge delete sessions database/sql",
      "Purge read users database/sql",
      "Rename update users database/sql",
      "Rename upsert audit database/sql",
      "main read orders database/sql",
    ]);
  });

  it("parses the statement kinds", () => {
    assert.deepEqual(sqlTableAccesses("SELECT * FROM a x, c JOIN b ON true"), [
      { table: "a", operation: "read" }, { table: "c", operation: "read" }, { table: "b", operation: "read" },
    ]);
    assert.deepEqual(sqlTableAccesses("WITH r AS (SELECT * FROM posts) INSERT INTO feed SELECT * FROM r"), [
      { table: "feed", operation: "create" }, { table: "posts", operation: "read" },
    ]);
    assert.deepEqual(sqlTableAccesses("UPDATE public.users SET name = 'from x' WHERE id IN (SELECT user_id FROM bans)"), [
      { table: "users", operation: "update" }, { table: "bans", operation: "read" },
    ]);
    assert.deepEqual(sqlTableAccesses("CREATE TABLE t (id int)"), []);
  });

  it("propagates to callers and entrypoints", async () => {
    await withStore(graph, async (tool) => {
      const impact = await tool("impact_of", { symbol: "Find" });
      assert.deepEqual(impact.tables.map((table: any) => [table.table, table.reads]), [["users", ["read"]]]);
      const tables = await tool("list_tables", { name: "users" });
      assert.ok(tables.tables[0].entrypoints.length > 0);
    });
  });
});
