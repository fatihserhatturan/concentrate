import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { nearestPackageDirectory, parseAttributes, parsePrismaSchema } from "../src/integrations/frameworks/js-ts/prisma-schema.js";

const fixturePath = path.join(import.meta.dirname, "../fixtures/prisma-schema");

describe("Prisma schema parser", () => {
  it("reads models, fields, attributes and the provider", () => {
    const parsed = parsePrismaSchema([
      "datasource db {",
      "  provider = \"mongodb\"",
      "  url      = env(\"URL\") // trailing comment",
      "}",
      "/// doc comment",
      "model User {",
      "  id    String  @id @map(\"_id\")",
      "  email String? @unique // \"quoted\" comment",
      "  tags  String[]",
      "  posts Post[]  @relation(\"Authored\")",
      "  @@map(\"users\")",
      "}",
    ].join("\n"), "schema.prisma");

    assert.equal(parsed.provider, "mongodb");
    assert.deepEqual(parsed.errors, []);
    const [user] = parsed.blocks;
    assert.equal(user!.kind, "model");
    assert.equal(user!.line, 6);
    assert.deepEqual(user!.attributes, [{ name: "map", args: [{ key: null, value: "users" }] }]);
    assert.deepEqual(user!.fields.map((field) => [field.name, field.type, field.list, field.optional]), [
      ["id", "String", false, false],
      ["email", "String", false, true],
      ["tags", "String", true, false],
      ["posts", "Post", true, false],
    ]);
    assert.deepEqual(user!.fields[0]!.attributes.map((attr) => attr.name), ["id", "map"]);
  });

  it("parses attribute arguments: positional, named, lists and nested calls", () => {
    assert.deepEqual(parseAttributes("@default(now()) @relation(\"A, B\", fields: [a, b], references: [id], onDelete: Cascade) @db.VarChar(255)"), [
      { name: "default", args: [{ key: null, value: "now()" }] },
      {
        name: "relation",
        args: [
          { key: null, value: "A, B" },
          { key: "fields", value: ["a", "b"] },
          { key: "references", value: ["id"] },
          { key: "onDelete", value: "Cascade" },
        ],
      },
      { name: "db.VarChar", args: [{ key: null, value: "255" }] },
    ]);
  });

  it("reads enums, views and composite types", () => {
    const parsed = parsePrismaSchema("enum Role {\n  USER\n  ADMIN @map(\"admin\")\n}\nview Stats {\n  n Int\n}\ntype Address {\n  city String\n}\n", "s.prisma");
    assert.deepEqual(parsed.blocks.map((block) => [block.kind, block.name, block.fields.map((field) => field.name)]), [
      ["enum", "Role", ["USER", "ADMIN"]],
      ["view", "Stats", ["n"]],
      ["type", "Address", ["city"]],
    ]);
  });

  it("reports unparsable lines and unclosed blocks and keeps the rest", () => {
    const parsed = parsePrismaSchema("stray\nmodel A {\n  id Int @id\n  = broken\n}\nmodel B {\n  id Int\n", "s.prisma");
    assert.deepEqual(parsed.blocks.map((block) => block.name), ["A"]);
    assert.deepEqual(parsed.errors.map((error) => error.line), [1, 4, 6]);
  });

  it("picks the nearest package directory", () => {
    assert.equal(nearestPackageDirectory("apps/api/prisma", [".", "apps/api", "apps/web"]), "apps/api");
    assert.equal(nearestPackageDirectory("prisma", [".", "apps/api"]), ".");
    assert.equal(nearestPackageDirectory("prisma", ["apps/api"]), null);
  });
});

describe("Prisma schema scan", () => {
  let store: GraphStore;
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;
  before(async () => {
    graph = await buildCodeGraph(fixturePath, { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-prisma-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  const call = async (name: string, args: Record<string, unknown>) =>
    (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  it("adds declared models (accessed or not) with their tables and relations", async () => {
    const tables = (await call("list_tables", {})).tables as Array<Record<string, any>>;
    assert.deepEqual(tables.map((table) => [table.name, table.kind, table.library]), [
      ["audit_log", "table", "knex"],
      ["posts", "table", "prisma"],
      ["PostStats", "view", "prisma"],
      ["Setting", "table", "prisma"],
      ["users", "table", "prisma"],
    ]);
    const users = tables.find((table) => table.name === "users")!;
    assert.deepEqual(users.columns.find((column: any) => column.name === "name"), { name: "name", type: "String", column: "display_name", optional: true });
    assert.deepEqual(users.models[0].relations.map((relation: any) => `${relation.field}:${relation.kind}:${relation.model}`), [
      "invited:many:User",
      "invitedBy:one:User",
      "posts:many:Post",
    ]);
    // @@unique([authorId, title]) is compound: neither column is unique alone.
    const posts = tables.find((table) => table.name === "posts")!;
    assert.equal(posts.columns.some((column: any) => column.isUnique), false);
    assert.deepEqual(posts.models[0].relations[0], { field: "author", kind: "one", model: "User", relationName: "AuthoredPosts", onDelete: "Cascade" });
  });

  it("links Prisma calls to declared models and derives READS / WRITES", async () => {
    const users = (await call("list_tables", { name: "users" })).tables[0];
    assert.deepEqual(users.readBy, { routes: 1, entrypoints: 0, functions: 2 });
    assert.deepEqual(users.routes.map((route: any) => [route.method, route.path, route.reads ?? [], route.writes ?? []]), [
      ["GET", "/users", ["read"], []],
      ["PATCH", "/users/:id", [], ["update"]],
    ]);
    // One DataModel per Prisma model: the accessor `user` resolved to `User`.
    assert.equal(graph.nodes.some((node) => node.id === "datamodel:prisma:user"), false);
    const rows = (await call("list_data_access", { model: "user" })).dataAccess as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0 && rows.every((row) => row.model === "User" && row.table === "users"));
  });

  it("lists tables in route_details and impact_of", async () => {
    const route = (await call("route_details", { method: "PATCH", path: "/users/:id" })).routes[0];
    assert.deepEqual(route.tables.map((table: any) => [table.table, table.writes]), [
      ["audit_log", ["create"]],
      ["users", ["update"]],
    ]);
    const impact = await call("impact_of", { symbol: "renameUser" });
    assert.deepEqual(impact.tables, [{ table: "users", kind: "table", library: "prisma", reads: [], writes: ["update"], usedBy: [{ function: "renameUser", functionFile: "src/users.ts" }] }]);
  });

  it("counts tables in the graph summary", async () => {
    const { graphSummary } = await import("../src/core/queries/summary.js");
    assert.deepEqual((await graphSummary(store)).tablesByLibrary, { knex: 1, prisma: 4 });
  });
});

describe("Prisma schemas in a monorepo", () => {
  it("keeps same-named models apart and links each package to its own schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-prisma-mono-"));
    const files: Record<string, string> = {
      "package.json": "{\"private\":true,\"workspaces\":[\"apps/*\"]}",
      "apps/a/package.json": "{\"name\":\"a\"}",
      "apps/a/prisma/schema.prisma": "model User {\n  id Int @id\n  @@map(\"a_users\")\n}\n",
      "apps/a/src/index.ts": "import { PrismaClient } from '@prisma/client'\nconst prisma = new PrismaClient()\nexport function load() {\n  return prisma.user.findMany()\n}\n",
      "apps/b/package.json": "{\"name\":\"b\"}",
      // A multi-file schema folder: the relation crosses files.
      "apps/b/prisma/schema/user.prisma": "model User {\n  id Int @id\n  posts Post[]\n}\n",
      "apps/b/prisma/schema/post.prisma": "model Post {\n  id Int @id\n  author User @relation(fields: [authorId], references: [id])\n  authorId Int\n}\n",
      "apps/b/src/index.ts": "import { PrismaClient } from '@prisma/client'\nconst prisma = new PrismaClient()\nexport function save() {\n  return prisma.user.create({ data: {} })\n}\n",
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content, "utf8");
    }
    const graph = await buildCodeGraph(root, { continueOnError: false });
    const access = (file: string) => graph.relationships
      .filter((rel) => rel.type === "ACCESSES_DATA" && rel.from.startsWith(`file:${file}:`))
      .map((rel) => rel.to);
    assert.deepEqual(access("apps/a/src/index.ts"), ["datamodel:prisma:apps/a/prisma/schema.prisma:User"]);
    assert.deepEqual(access("apps/b/src/index.ts"), ["datamodel:prisma:apps/b/prisma/schema/user.prisma:User"]);
    assert.ok(graph.relationships.some((rel) => rel.type === "RELATES_TO"
      && rel.from === "datamodel:prisma:apps/b/prisma/schema/post.prisma:Post"
      && rel.to === "datamodel:prisma:apps/b/prisma/schema/user.prisma:User"));
    assert.ok(graph.relationships.some((rel) => rel.type === "WRITES" && rel.to === "table:prisma:apps/b/prisma/schema/user.prisma:User"));
    assert.ok(graph.relationships.some((rel) => rel.type === "READS" && rel.to === "table:prisma:apps/a/prisma/schema.prisma:a_users"));
  });

  it("turns schema parse errors into scan warnings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-prisma-bad-"));
    await writeFile(path.join(root, "schema.prisma"), "model A {\n  id Int @id\n  ???\n}\n", "utf8");
    const result = await buildCodeGraph(root, { continueOnError: false });
    assert.deepEqual(result.report.warnings, [{ path: "schema.prisma", message: "Prisma schema line 3: Unrecognized field in model A" }]);
    assert.ok(result.nodes.some((node) => node.label === "Table" && node.properties.name === "A"));
  });
});

describe("Prisma clients injected as subclasses", () => {
  it("treats fields typed as a PrismaClient subclass as Prisma clients", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-prisma-service-"));
    const files: Record<string, string> = {
      "package.json": "{\"name\":\"nest-prisma\"}",
      "prisma/schema.prisma": "model Post {\n  id Int @id\n}\n",
      "src/prisma.service.ts": "import { PrismaClient } from '@prisma/client'\nexport class BasePrisma extends PrismaClient {}\nexport class PrismaService extends BasePrisma {}\n",
      "src/posts.service.ts": [
        "import { PrismaService } from './prisma.service'",
        "export class PostsService {",
        "  constructor(private prisma: PrismaService) {}",
        "  findAll() {",
        "    return this.prisma.post.findMany()",
        "  }",
        "}",
        "",
      ].join("\n"),
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content, "utf8");
    }
    const graph = await buildCodeGraph(root, { continueOnError: false });
    assert.ok(graph.relationships.some((rel) => rel.type === "ACCESSES_DATA" && rel.to === "datamodel:prisma:prisma/schema.prisma:Post"));
    assert.ok(graph.relationships.some((rel) => rel.type === "READS" && rel.to === "table:prisma:prisma/schema.prisma:Post"));
  });
});
