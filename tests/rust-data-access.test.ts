import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { sqlTableAccesses } from "../src/integrations/frameworks/go/sql.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

// [function, operation, model, library] for each access a function itself makes.
function accesses(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "ACCESSES_DATA" && byId.get(rel.from)?.label === "Function" && rel.properties.direct === true)
    .map((rel) => `${byId.get(rel.from)!.properties.name} ${rel.properties.operation} ${byId.get(rel.to)!.properties.name} ${rel.properties.library}`)
    .sort();
}

describe("Rust data access", () => {
  let graph: Graph;
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;
  const names = (type: string) => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.relationships
      .filter((rel) => rel.type === type)
      .map((rel) => `${byId.get(rel.from)!.properties.name}${type === "RELATES_TO" ? ` ${rel.properties.field}` : ""}=${byId.get(rel.to)!.properties.name}`)
      .sort();
  };

  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/rust-data"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-rust-data-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("finds sqlx, diesel and SeaORM accesses with their functions", () => {
    assert.deepEqual(accesses(graph), [
      // SeaORM: Entity::find, an alias from the prelude, ActiveModel writes, delete_many.
      "bake create Cake sea-orm",
      "clear delete Filling sea-orm",
      // diesel: the DSL root decides the operation; on_conflict upserts.
      "create_post create Post diesel",
      "fillings_of read Filling sea-orm",
      "list_cakes read Cake sea-orm",
      // sqlx: query_as::<_, User> maps to the FromRow struct of the one table.
      "list_users read User sqlx",
      "purge delete Post diesel",
      "remove delete users sqlx",
      "rename update users sqlx",
      "reprice read Cake sea-orm",
      "reprice update Cake sea-orm",
      "retitle update Post diesel",
      // a const, a join; the dynamic `format!` SQL is left out.
      "stats read orders sqlx",
      "stats read users sqlx",
      "titles_of read Account diesel",
      "titles_of read Post diesel",
      "upsert_user upsert Account diesel",
    ]);
  });

  it("makes tables, models and relations", () => {
    assert.deepEqual(names("MAPS_TO_TABLE"), [
      "Account=users", "Cake=cakes", "Filling=fillings", "NewPost=posts", "Post=posts", "User=users", "orders=orders", "users=users",
    ]);
    assert.deepEqual(names("RELATES_TO"), ["Cake Filling=Filling", "Filling Cake=Cake", "Post Account=Account"]);
    const posts = graph.nodes.find((node) => node.label === "Table" && node.properties.name === "posts")!;
    assert.deepEqual(JSON.parse(String(posts.properties.columns)).map((column: any) => [column.name, column.type, column.isId]), [["id", "Int4", true], ["user_id", "Int4", false], ["title", "Text", false]]);
    const cakes = graph.nodes.find((node) => node.label === "Table" && node.properties.name === "cakes")!;
    assert.deepEqual(JSON.parse(String(cakes.properties.columns)).map((column: any) => [column.name, column.optional, column.isId]), [["id", false, true], ["name", false, false], ["price", true, false]]);
    assert.ok(graph.nodes.every((node) => !("rustData" in node.properties)));
  });

  it("reads the tables of SQL with data-modifying CTEs", () => {
    const sql = (text: string) => sqlTableAccesses(text).map((access) => `${access.operation} ${access.table}`).sort();
    assert.deepEqual(sql("with ins as (insert into article (a) values ($1) returning a) select ins.*, u.name from ins join \"user\" u on u.id = $1"), ["create article", "read user"]);
    assert.deepEqual(sql("with del as (delete from article_favorite where article_id = 1) select 1"), ["delete article_favorite"]);
    assert.deepEqual(sql("with sel as (select id from article where slug = $1), ins as (insert into fav(a) select id from sel on conflict do nothing) select id from sel"), ["read article", "upsert fav"]);
  });

  it("reaches routes through READS and WRITES, list_data_access, list_tables and impact_of", async () => {
    const reads = graph.relationships.filter((rel) => rel.type === "READS" && graph.nodes.find((node) => node.id === rel.from)?.label === "Route");
    const routeTables = new Set(reads.map((rel) => `${graph.nodes.find((node) => node.id === rel.from)!.properties.fullPath} ${graph.nodes.find((node) => node.id === rel.to)!.properties.name}`));
    assert.ok(routeTables.has("/cakes cakes"));
    assert.ok(routeTables.has("/stats orders"));
    const writes = graph.relationships.filter((rel) => rel.type === "WRITES" && graph.nodes.find((node) => node.id === rel.from)?.label === "Route");
    assert.ok(writes.some((rel) => graph.nodes.find((node) => node.id === rel.from)!.properties.fullPath === "/posts" && graph.nodes.find((node) => node.id === rel.to)!.properties.name === "posts"));

    const tables = await tool("list_tables", { name: "posts" });
    assert.deepEqual(tables.tables[0].routes.map((route: any) => `${route.method} ${route.path}`), ["POST /posts"]);
    const access = await tool("list_data_access", { model: "Cake", operation: "read" });
    assert.ok(access.dataAccess.some((row: any) => row.sourceKind === "Route" && row.sourceName === "/cakes"));
    const impact = await tool("impact_of", { symbol: "create_post" });
    assert.deepEqual(impact.tables.map((table: any) => [table.table, table.writes]), [["posts", ["create"]]]);
  });
});
