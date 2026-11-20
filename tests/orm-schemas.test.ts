import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { mongooseCollectionName, snakeCase } from "../src/integrations/frameworks/js-ts/data-schemas.js";
import { openTestStore } from "./helpers/store.js";

const fixturePath = path.join(import.meta.dirname, "../fixtures/orm-schemas");

type Table = Record<string, any>;

describe("ORM naming defaults", () => {
  it("names TypeORM tables in snake case and Mongoose collections in the plural", () => {
    assert.equal(snakeCase("User"), "user");
    assert.equal(snakeCase("PhotoMetadata"), "photo_metadata");
    assert.equal(snakeCase("HTTPRequestLog"), "http_request_log");
    assert.deepEqual(["Cat", "Box", "Category", "Day", "Match"].map(mongooseCollectionName), ["cats", "boxes", "categories", "days", "matches"]);
  });
});

describe("TypeORM, Mongoose and Drizzle declarations", () => {
  let store: GraphStore;
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;
  let tables: Table[];
  before(async () => {
    graph = await buildCodeGraph(fixturePath, { continueOnError: false });
    store = await openTestStore(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-orm-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
    tables = (await call("list_tables", { limit: 50 })).tables;
  });
  after(async () => {
    await store.close();
  });

  const call = async (name: string, args: Record<string, unknown>) =>
    (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;
  const table = (name: string) => tables.find((entry) => entry.name === name)!;

  it("adds a table per entity, schema and table definition", () => {
    assert.deepEqual(tables.map((entry) => [entry.name, entry.kind, entry.library, entry.models.map((model: any) => model.name).join()]), [
      ["accounts", "table", "drizzle", "accounts"],
      ["app_users", "table", "typeorm", "User"],
      ["cats", "collection", "mongoose", "Cat"],
      ["felines", "collection", "mongoose", "Owner"],
      ["photo", "table", "typeorm", "Photo"],
      ["photo_album", "table", "typeorm", "PhotoAlbum"],
      ["sessions", "table", "drizzle", "sessions"],
      ["toys", "collection", "mongoose", "Toy"],
      ["user_photo_counts", "view", "typeorm", "UserPhotoCount"],
    ]);
    // No transient parse-time property reaches the graph.
    assert.equal(graph.nodes.some((node) => "pendingRelations" in node.properties), false);
  });

  it("reads TypeORM column and relation decorators", () => {
    const users = table("app_users");
    assert.equal(users.schemaName, "auth");
    assert.deepEqual(users.columns, [
      { name: "id", type: "number", isId: true },
      { name: "email", type: "string", column: "email_address", isUnique: true },
      { name: "nickname", type: "varchar", optional: true },
      { name: "createdAt", type: "Date" },
    ]);
    assert.deepEqual(users.models[0].relations, [{ field: "photos", kind: "many", model: "Photo" }]);
    assert.deepEqual(table("photo").models[0].relations, [{ field: "owner", kind: "one", model: "User", onDelete: "CASCADE" }]);
    const owner = graph.relationships.find((rel) => rel.type === "RELATES_TO" && rel.properties.field === "owner" && rel.from.includes(":typeorm:"));
    assert.equal(owner?.properties.fields, "[\"owner_id\"]");
  });

  it("reads Mongoose schema classes and schema objects", () => {
    assert.deepEqual(table("cats").columns, [
      { name: "name", type: "string" },
      { name: "age", type: "number", optional: true },
      { name: "owner", type: "ObjectId", optional: true },
      { name: "tags", type: "string", optional: true, list: true },
    ]);
    assert.deepEqual(table("cats").models[0].relations, [{ field: "owner", kind: "one", model: "Owner" }]);
    assert.deepEqual(table("felines").columns, [{ name: "name", type: "string", isUnique: true }]);
    // A JS schema object named by mongoose.model('Toy', toySchema), referring to a class in another file.
    const toys = table("toys");
    assert.equal(toys.declaredIn, "src/mongoose/toy.model.js");
    assert.deepEqual(toys.columns.map((column: any) => [column.name, column.type, column.list ?? false]), [
      ["label", "String", false],
      ["price", "Number", false],
      ["cat", "ObjectId", false],
      ["colors", "String", true],
    ]);
    assert.deepEqual(toys.models[0].relations, [{ field: "cat", kind: "one", model: "Cat" }]);
  });

  it("reads Drizzle columns and references", () => {
    assert.deepEqual(table("accounts").columns, [
      { name: "id", type: "serial", isId: true },
      { name: "handle", type: "text", isUnique: true },
      { name: "bio", type: "text", optional: true },
    ]);
    assert.equal(table("accounts").provider, "postgresql");
    assert.deepEqual(table("sessions").columns[1], { name: "accountId", type: "integer", column: "account_id" });
    assert.deepEqual(table("sessions").models[0].relations, [{ field: "accountId", kind: "one", model: "accounts", onDelete: "cascade" }]);
  });

  it("links repository, model and query accesses to the declared tables", () => {
    assert.deepEqual([table("photo").readBy.functions, table("photo").writtenBy.functions], [1, 1]);
    assert.deepEqual([table("cats").readBy.functions, table("cats").writtenBy.functions], [1, 1]);
    assert.deepEqual(table("sessions").routes.map((route: any) => [route.method, route.path, route.writes]), [
      ["POST", "/sessions", ["create"]],
      ["DELETE", "/sessions", ["delete"]],
    ]);
    // db.select().from(accounts) and db.query.accounts.findFirst() both read accounts.
    assert.deepEqual(table("accounts").routes.map((route: any) => [route.method, route.path, route.reads]), [
      ["GET", "/accounts/:id", ["read"]],
      ["POST", "/sessions", ["read"]],
    ]);
    // Only declared models: no model named after a repository or variable.
    assert.equal(graph.nodes.some((node) => node.label === "DataModel" && typeof node.properties.declaredIn !== "string"), false);
  });

  it("lists the tables a route touches", async () => {
    const route = (await call("route_details", { method: "POST", path: "/sessions" })).routes[0];
    assert.deepEqual(route.tables.map((entry: any) => [entry.table, entry.library, entry.reads, entry.writes]), [
      ["accounts", "drizzle", ["read"], []],
      ["sessions", "drizzle", [], ["create"]],
    ]);
  });
});

describe("ORM declarations across packages", () => {
  it("links each package's repository to its own entity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-orm-mono-"));
    const entity = (table: string) => `import { Entity, PrimaryColumn } from 'typeorm'\n@Entity('${table}')\nexport class User {\n  @PrimaryColumn()\n  id: string\n}\n`;
    const service = "import { Repository } from 'typeorm'\nimport { User } from './user.entity'\nexport class Users {\n  constructor(private readonly users: Repository<User>) {}\n  all() {\n    return this.users.find()\n  }\n}\n";
    const files: Record<string, string> = {
      "package.json": "{\"private\":true}",
      "apps/a/package.json": "{\"name\":\"a\"}",
      "apps/a/src/user.entity.ts": entity("a_users"),
      "apps/a/src/users.ts": service,
      "apps/b/package.json": "{\"name\":\"b\"}",
      "apps/b/src/user.entity.ts": entity("b_users"),
      "apps/b/src/users.ts": service,
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content, "utf8");
    }
    const graph = await buildCodeGraph(root, { continueOnError: false });
    const reads = graph.relationships.filter((rel) => rel.type === "READS").map((rel) => `${rel.from.split(":")[1]} -> ${rel.to}`).sort();
    assert.deepEqual(reads, [
      "apps/a/src/users.ts -> table:typeorm:apps/a/src/user.entity.ts:a_users",
      "apps/b/src/users.ts -> table:typeorm:apps/b/src/user.entity.ts:b_users",
    ]);
  });

  it("reads MongoRepository<T> as a repository of T", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-orm-mongo-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/photo.ts"), [
      "import { Entity, MongoRepository, ObjectIdColumn } from 'typeorm'",
      "@Entity()",
      "export class Photo {",
      "  @ObjectIdColumn()",
      "  id: string",
      "}",
      "export class Photos {",
      "  constructor(private readonly photoRepository: MongoRepository<Photo>) {}",
      "  all() {",
      "    return this.photoRepository.find()",
      "  }",
      "}",
      "",
    ].join("\n"), "utf8");
    const graph = await buildCodeGraph(root, { continueOnError: false });
    const table = graph.nodes.find((node) => node.label === "Table");
    assert.deepEqual([table?.properties.name, table?.properties.kind], ["photo", "collection"]);
    assert.ok(graph.relationships.some((rel) => rel.type === "READS" && rel.to === table?.id));
    assert.equal(graph.nodes.some((node) => node.label === "DataModel" && node.properties.name === "Mongo"), false);
  });
});
