import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultCoreIntegrationRegistry } from "../src/composition/default-registry.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { GraphNode } from "../src/core/graph/model.js";
import { dataAccessContributor } from "../src/integrations/frameworks/js-ts/data-access.js";
import {
  javaDataModel,
  javaTable,
  javaTableId,
  normalizeTableName,
  recordJavaDataAccesses,
  sqlAccesses,
  sqlModelAccesses,
} from "../src/integrations/frameworks/java/data-shared.js";

const node = (id: string, label: GraphNode["label"], properties: GraphNode["properties"] = {}): GraphNode => ({ id, label, properties });

describe("Java tables and data models", () => {
  it("makes one Table per name, whatever the case, with the shape the other languages use", () => {
    const graph = new GraphBuilder();
    const id = javaTable(graph, "Users", { library: "jpa" });
    assert.equal(id, "table:java:-:users");
    assert.equal(javaTable(graph, "users"), id);
    assert.equal(javaTable(graph, '"public"."USERS"'), id);
    assert.deepEqual(graph.node(id)!.properties, {
      name: "users", kind: "table", library: "jpa", schemaName: null, provider: null, declaredIn: null, line: null, columns: "[]",
    });
    assert.equal(graph.nodesWithLabel("Table").length, 1);
    assert.equal(javaTableId("a"), "table:java:-:a");
    assert.equal(normalizeTableName("`db`.`orders`"), "orders");
  });

  it("fills in the declaration of a table a query named first", () => {
    const graph = new GraphBuilder();
    const id = javaTable(graph, "orders", { library: "jdbc" });
    javaTable(graph, "ORDERS", { library: "jpa", declaredIn: "src/Order.java", line: 7, schemaName: "shop", columns: [{ name: "id", column: "id", isId: true }] });
    assert.deepEqual(
      [graph.node(id)!.properties.library, graph.node(id)!.properties.declaredIn, graph.node(id)!.properties.line, graph.node(id)!.properties.schemaName, graph.node(id)!.properties.columns],
      ["jpa", "src/Order.java", 7, "shop", '[{"name":"id","column":"id","isId":true}]'],
    );
    // Declared once: a later declaration does not replace it.
    javaTable(graph, "orders", { declaredIn: "zzz.java", line: 1 });
    assert.equal(graph.node(id)!.properties.declaredIn, "src/Order.java");
  });

  it("is deterministic: the id is lower-cased and the name is a declaration's spelling (the smallest), whatever the order", () => {
    const build = (order: Array<[string, { declaredIn?: string; line?: number }]>) => {
      const graph = new GraphBuilder();
      for (const [name, extra] of order) javaTable(graph, name, extra);
      return graph.nodesWithLabel("Table").map((table) => [table.id, table.properties.name, table.properties.declaredIn]);
    };
    const declared: Array<[string, { declaredIn: string; line: number }]> = [["Items", { declaredIn: "a/Item.java", line: 3 }], ["ITEMS", { declaredIn: "b/Item2.java", line: 3 }]];
    const expected = [["table:java:-:items", "ITEMS", "b/Item2.java"]];
    assert.deepEqual(build([...declared, ["items", {}]]), expected);
    assert.deepEqual(build([["items", {}], ...declared].reverse() as typeof declared), expected);
    assert.deepEqual(build([["ITEMS", {}], declared[1]!, declared[0]!]), expected);
    // A table only a query names is lower-cased.
    assert.deepEqual(build([["Orders", {}]]), [["table:java:-:orders", "orders", null]]);
  });

  it("creates a DataModel mapped to its table, once", () => {
    const graph = new GraphBuilder();
    const table = javaTable(graph, "users");
    const id = javaDataModel(graph, { name: "User", library: "jpa", scope: "com.acme", declaredIn: "src/User.java", line: 5, table });
    assert.equal(id, "datamodel:jpa:com.acme:User");
    assert.equal(javaDataModel(graph, { name: "User", library: "jpa", scope: "com.acme", table }), id);
    assert.deepEqual(graph.node(id)!.properties, { name: "User", library: "jpa", declaredIn: "src/User.java", line: 5 });
    assert.deepEqual(graph.relationshipsOfType("MAPS_TO_TABLE").map((rel) => [rel.from, rel.to]), [[id, table]]);
  });

  it("maps literal SQL to tables through the shared SQL reader", () => {
    assert.deepEqual(sqlAccesses("SELECT * FROM a JOIN b ON 1=1"), [{ table: "a", operation: "read" }, { table: "b", operation: "read" }]);
    const graph = new GraphBuilder();
    javaTable(graph, "Orders", { library: "jpa" });
    const accesses = sqlModelAccesses(graph, "insert into orders select * from archive", "jdbc");
    assert.deepEqual(accesses.map((access) => [access.modelId, access.table, access.operation]), [
      ["datamodel:jdbc:orders", "table:java:-:orders", "create"],
      ["datamodel:jdbc:archive", "table:java:-:archive", "read"],
    ]);
    assert.equal(graph.nodesWithLabel("Table").length, 2);
    assert.equal(graph.nodesWithLabel("DataModel").length, 2);
  });
});

describe("Java contributors in the default registry", () => {
  it("run before the language-neutral ones that read what they make", () => {
    const order = createDefaultCoreIntegrationRegistry().semanticContributors.map((contributor) => contributor.id);
    const position = (id: string) => {
      const index = order.indexOf(id);
      assert.notEqual(index, -1, id);
      return index;
    };
    for (const id of ["java.data-jpa", "java.data-jdbc"]) {
      assert.ok(position(id) < position("js-ts.data-access"), `${id} before js-ts.data-access`);
      assert.ok(position(id) < position("sql.schema"), `${id} before sql.schema`);
    }
    assert.ok(position("java.http-clients") < position("js-ts.http-requests"));
    assert.ok(position("java.config-env") < position("js-ts.env-config"));
    assert.ok(position("java.config-env") < position("js-ts.env-files"));
    // Routes exist before requests are matched to them.
    assert.ok(position("java.routes") < position("js-ts.http-requests"));
  });
});

describe("Java data accesses", () => {
  // controller → service → repository method that runs the SQL; a route handled by the controller.
  function project() {
    const graph = new GraphBuilder();
    graph.addNodes([
      node("file:src/Repo.java", "File", { relativePath: "src/Repo.java" }),
      node("file:src/Repo.java:function:3:Repo.find", "Function"),
      node("file:src/Repo.java:function:3:Repo.find:call:4:5:jdbc.query", "Call", { line: 4, expression: "jdbc.query" }),
      node("file:src/Svc.java", "File", { relativePath: "src/Svc.java" }),
      node("file:src/Svc.java:function:3:Svc.load", "Function"),
      node("file:src/Svc.java:function:3:Svc.load:call:4:5:repo.find", "Call", { line: 4, expression: "repo.find" }),
      node("file:src/Ctl.java:function:3:Ctl.get", "Function"),
      node("file:src/Ctl.java:function:3:Ctl.get:call:4:5:svc.load", "Call", { line: 4, expression: "svc.load" }),
      node("route:get", "Route", { method: "GET", fullPath: "/x" }),
    ]);
    graph.addRelationships([
      { from: "file:src/Repo.java:function:3:Repo.find", to: "file:src/Repo.java:function:3:Repo.find:call:4:5:jdbc.query", type: "CALLS", properties: {} },
      { from: "file:src/Svc.java:function:3:Svc.load", to: "file:src/Svc.java:function:3:Svc.load:call:4:5:repo.find", type: "CALLS", properties: {} },
      { from: "file:src/Svc.java:function:3:Svc.load:call:4:5:repo.find", to: "file:src/Repo.java:function:3:Repo.find", type: "CALL_RESOLVES_TO", properties: {} },
      { from: "file:src/Ctl.java:function:3:Ctl.get", to: "file:src/Ctl.java:function:3:Ctl.get:call:4:5:svc.load", type: "CALLS", properties: {} },
      { from: "file:src/Ctl.java:function:3:Ctl.get:call:4:5:svc.load", to: "file:src/Svc.java:function:3:Svc.load", type: "CALL_RESOLVES_TO", properties: {} },
      { from: "route:get", to: "file:src/Ctl.java:function:3:Ctl.get", type: "ROUTE_HANDLED_BY", properties: {} },
    ]);
    return graph;
  }

  it("records ACCESSES_DATA from the function, its callers and routes, and READS / WRITES follow", async () => {
    const graph = project();
    const [read, write] = sqlModelAccesses(graph, "INSERT INTO log SELECT * FROM users", "jdbc") as [ReturnType<typeof sqlModelAccesses>[number], ReturnType<typeof sqlModelAccesses>[number]];
    const call = "file:src/Repo.java:function:3:Repo.find:call:4:5:jdbc.query";
    recordJavaDataAccesses(graph, [read, write].map((access) => ({ callId: call, modelId: access.modelId, operation: access.operation, library: "jdbc", line: 4, expression: "jdbc.query" })));
    const accesses = graph.relationshipsOfType("ACCESSES_DATA").map((rel) => `${rel.from.split(":function:")[0]!.replace("file:src/", "")}${rel.from.startsWith("route") ? "" : "#" + rel.from.split(".").at(-1)}>${rel.to}:${String(rel.properties.operation)}:${String(rel.properties.file)}:${String(rel.properties.direct)}`).sort();
    assert.deepEqual(accesses, [
      "Ctl.java#get>datamodel:jdbc:log:create:src/Repo.java:false",
      "Ctl.java#get>datamodel:jdbc:users:read:src/Repo.java:false",
      "Repo.java#find>datamodel:jdbc:log:create:src/Repo.java:true",
      "Repo.java#find>datamodel:jdbc:users:read:src/Repo.java:true",
      "Svc.java#load>datamodel:jdbc:log:create:src/Repo.java:false",
      "Svc.java#load>datamodel:jdbc:users:read:src/Repo.java:false",
      "route:get>datamodel:jdbc:log:create:src/Repo.java:false",
      "route:get>datamodel:jdbc:users:read:src/Repo.java:false",
    ]);
    // `js-ts.data-access` turns them into READS / WRITES to the tables.
    await dataAccessContributor.contribute(graph, "/nowhere", {} as never, [], { apiOrigins: [] });
    const tables = graph.relationshipsOfType("READS").concat(graph.relationshipsOfType("WRITES")).filter((rel) => rel.from === "route:get").map((rel) => `${rel.type}:${rel.to}`).sort();
    assert.deepEqual(tables, ["READS:table:java:-:users", "WRITES:table:java:-:log"]);
  });

  it("records the access of a function declaration (a repository or mapper method) for its callers", () => {
    const graph = project();
    const table = javaTable(graph, "users");
    const model = javaDataModel(graph, { name: "User", library: "spring-data", table });
    recordJavaDataAccesses(graph, [{ functionId: "file:src/Repo.java:function:3:Repo.find", modelId: model, operation: "read", library: "spring-data", line: 3, expression: "Repo.find" }]);
    assert.deepEqual(graph.relationshipsOfType("ACCESSES_DATA").map((rel) => rel.from.replace(/^file:src\//u, "").split(":function")[0]).sort(), ["Ctl.java", "Repo.java", "Svc.java", "route:get"]);
    // Recording the same access again adds nothing.
    const count = graph.relationshipsOfType("ACCESSES_DATA").length;
    recordJavaDataAccesses(graph, [{ functionId: "file:src/Repo.java:function:3:Repo.find", modelId: model, operation: "read", library: "spring-data", line: 3, expression: "Repo.find" }]);
    assert.equal(graph.relationshipsOfType("ACCESSES_DATA").length, count);
  });
});
