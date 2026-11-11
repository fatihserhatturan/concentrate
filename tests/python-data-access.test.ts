import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const name = (graph: Graph, id: string) => String(graph.nodes.find((node) => node.id === id)!.properties.name);
const access = (graph: Graph) => graph.relationships
  .filter((rel) => rel.type === "ACCESSES_DATA" && graph.nodes.find((node) => node.id === rel.from)?.label === "Function")
  .map((rel) => `${name(graph, rel.from)} ${rel.properties.operation} ${name(graph, rel.to)} ${rel.properties.library}`)
  .sort();
const edges = (graph: Graph, type: string) => graph.relationships
  .filter((rel) => rel.type === type)
  .map((rel) => (type === "RELATES_TO" ? `${name(graph, rel.from)} ${rel.properties.field}:${rel.properties.kind}=${name(graph, rel.to)}` : `${name(graph, rel.from)}=${name(graph, rel.to)}`))
  .sort();
const tables = (graph: Graph) => graph.nodes
  .filter((node) => node.label === "Table")
  .map((node) => {
    const columns = (JSON.parse(String(node.properties.columns)) as Array<Record<string, any>>).map((column) => `${column.name}${column.isId ? "*" : ""}${column.optional ? "?" : ""}${column.references ? `>${column.references}` : ""}`);
    const migrations = node.properties.migrations ? (JSON.parse(String(node.properties.migrations)) as Array<Record<string, any>>).map((entry) => `${String(entry.file).split("/").pop()}:${entry.line}:${entry.change}`) : [];
    return `${node.properties.name} ${node.properties.library} ${columns.join(",")} ${migrations.join("|")}`;
  })
  .sort();

describe("Python data access", () => {
  let sqlalchemy: Graph;
  let django: Graph;
  let store: GraphStore;
  const tool = async (toolName: string, args: Record<string, unknown>) => (await callMcpTool(store, toolName, args)).structuredContent as Record<string, any>;

  before(async () => {
    sqlalchemy = await buildCodeGraph(path.resolve("fixtures/python-sqlalchemy"), { continueOnError: false });
    django = await buildCodeGraph(path.resolve("fixtures/python-django-orm"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-python-data-")), "graph"));
    await store.reset();
    await store.write(sqlalchemy.nodes, sqlalchemy.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("makes SQLAlchemy tables with mixin columns, keys, Table() and Alembic merged in", () => {
    assert.deepEqual(tables(sqlalchemy), [
      "audit_log alembic id*,event? 0001_initial.py:13:create|0001_initial.py:24:drop",
      "authors sqlalchemy id*,name,bio?,created_at? 0001_initial.py:8:create|0001_initial.py:18:add column bio|0001_initial.py:23:drop column bio",
      "book_tags sqlalchemy book_id?>books.id,tag? ",
      "books sqlalchemy id*,title,author_id?>authors.id ",
      "orders dbapi  ",
      // Flask-SQLAlchemy names the table after the class.
      "publisher sqlalchemy id*,label? ",
      "reviews sqlalchemy id*,book_id>books.id,body? ",
    ]);
    assert.deepEqual(edges(sqlalchemy, "MAPS_TO_TABLE"), ["Author=authors", "Book=books", "Publisher=publisher", "Review=reviews", "book_tags=book_tags", "orders=orders"]);
  });

  it("relates models through relationship(), backref, back_populates and secondary", () => {
    assert.deepEqual(edges(sqlalchemy, "RELATES_TO"), [
      "Author books:many=Book",
      "Book author:one=Author",
      "Book publishers:many=Publisher",
      "Book reviews:many=Review",
      "Publisher books:many=Book",
      "Review book:one=Book",
    ]);
  });

  it("links queries, session writes, legacy Model.query and literal SQL to the models and tables", () => {
    assert.deepEqual(access(sqlalchemy), [
      "add_author create Author sqlalchemy",
      "authors read Author sqlalchemy",
      "book read Book sqlalchemy",
      "bulk create Publisher sqlalchemy",
      "bulk delete Book sqlalchemy",
      "create_author create Author sqlalchemy",
      "delete_review delete Review sqlalchemy",
      "find_book read Book sqlalchemy",
      "legacy read Publisher sqlalchemy",
      "list_authors read Author sqlalchemy",
      // asyncpg and sqlite3: the f-string hole keeps the statement, a non-SQL string is ignored.
      "raw_asyncpg create orders dbapi",
      "raw_asyncpg read Publisher dbapi",
      "raw_asyncpg read Publisher dbapi",
      "raw_asyncpg read orders dbapi",
      "raw_sqlite create Review dbapi",
      "raw_sqlite delete book_tags dbapi",
      "raw_sqlite read Author dbapi",
      "raw_sqlite read Book dbapi",
      "raw_sqlite update Book dbapi",
      "remove_review delete Review sqlalchemy",
      "rename_author delete Review sqlalchemy",
      "rename_author update Author sqlalchemy",
      "titles read Book sqlalchemy",
      // A migration's own SQL belongs to its function.
      "upgrade update Author dbapi",
    ]);
    assert.ok(sqlalchemy.nodes.every((node) => !("pyData" in node.properties)));
  });

  it("makes Django models with abstract bases, db_table, managers and reverse relations", () => {
    assert.deepEqual(tables(django), [
      "blog_author django name,created,id*,bio? 0001_initial.py:6:create|0002_post_published.py:7:add column bio",
      "blog_comment django post>blog.Post,body,id* ",
      // A table only a migration creates.
      "blog_legacy django id* 0001_initial.py:22:create",
      "blog_posts django title,published,author>Author,created,id* 0001_initial.py:13:create|0002_post_published.py:6:add column published",
      "blog_tag django slug* ",
    ]);
    assert.deepEqual(edges(django, "MAPS_TO_TABLE"), ["Author=blog_author", "Comment=blog_comment", "Post=blog_posts", "Tag=blog_tag"]);
    assert.deepEqual(edges(django, "RELATES_TO"), [
      "Author followers:many=Author",
      "Author following:many=Author",
      "Author posts:many=Post",
      "Comment post:one=Post",
      "Post author:one=Author",
      "Post comment_set:many=Comment",
      "Post tags:many=Tag",
      "Tag post_set:many=Post",
    ]);
  });

  it("links Model.objects, custom managers, chained writes and instance.save()", () => {
    assert.deepEqual(access(django), [
      "get read Author django",
      "post_create create Comment django",
      "post_create create Post django",
      "post_create read Author django",
      "post_detail read Post django",
      "post_list read Post django",
      "post_publish delete Tag django",
      "post_publish update Post django",
    ]);
    const routes = django.relationships
      .filter((rel) => (rel.type === "READS" || rel.type === "WRITES") && django.nodes.find((node) => node.id === rel.from)?.label === "Route")
      .map((rel) => `${django.nodes.find((node) => node.id === rel.from)!.properties.fullPath} ${rel.type} ${name(django, rel.to)}`)
      .sort();
    assert.deepEqual(routes, [
      "/blog/authors/ READS blog_author",
      "/blog/posts/ READS blog_posts",
      "/blog/posts/<int:pk>/ READS blog_posts",
      "/blog/posts/<int:pk>/publish/ WRITES blog_posts",
      "/blog/posts/<int:pk>/publish/ WRITES blog_tag",
      "/blog/posts/new/ READS blog_author",
      "/blog/posts/new/ WRITES blog_comment",
      "/blog/posts/new/ WRITES blog_posts",
    ]);
  });

  it("reaches FastAPI routes and the tools", async () => {
    const reads = sqlalchemy.relationships
      .filter((rel) => (rel.type === "READS" || rel.type === "WRITES") && sqlalchemy.nodes.find((node) => node.id === rel.from)?.label === "Route")
      .map((rel) => `${sqlalchemy.nodes.find((node) => node.id === rel.from)!.properties.fullPath} ${rel.type} ${name(sqlalchemy, rel.to)}`)
      .sort();
    assert.deepEqual(reads, ["/authors READS authors", "/authors WRITES authors", "/books/{book_id} READS books", "/reviews/{review_id} WRITES reviews"]);

    const authors = await tool("list_tables", { name: "authors" });
    assert.deepEqual(authors.tables[0].routes.map((route: any) => `${route.method} ${route.path}`).sort(), ["GET /authors", "POST /authors"]);
    const filtered = await tool("list_tables", { library: "sqlalchemy" });
    assert.deepEqual(filtered.tables.map((table: any) => table.name).sort(), ["authors", "book_tags", "books", "publisher", "reviews"]);
    const model = await tool("list_data_access", { model: "Review", operation: "delete" });
    assert.ok(model.dataAccess.some((row: any) => row.sourceKind === "Route" && row.sourceName === "/reviews/{review_id}"));
    const impact = await tool("impact_of", { symbol: "add_author" });
    assert.deepEqual(impact.tables.map((table: any) => [table.table, table.writes]), [["authors", ["create"]]]);
  });
});
