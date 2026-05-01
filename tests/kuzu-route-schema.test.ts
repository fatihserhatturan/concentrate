import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { GraphNode, GraphRelationship } from "../src/graph/model.js";
import { SCHEMA_VERSION } from "../src/graph/schema.js";
import { KuzuGraphWriter } from "../src/graph/kuzu-writer.js";

describe("Kuzu route schema", () => {
  it("writes Route nodes and route relationships", async () => {
    const databasePath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "concentrate-route-schema-")),
      "graph.kuzu",
    );
    const writer = await KuzuGraphWriter.open(databasePath);
    await writer.reset();

    const nodes: GraphNode[] = [
      {
        id: "file:routes.ts",
        label: "File",
        properties: {
          path: "/tmp/routes.ts",
          relativePath: "routes.ts",
          language: "typescript",
        },
      },
      {
        id: "file:routes.ts:function:3:listUsers",
        label: "Function",
        properties: {
          name: "listUsers",
          kind: "function_declaration",
          methodKind: null,
          line: 3,
          endLine: 5,
          className: null,
          isExported: false,
          isAsync: true,
          isAbstract: false,
          visibility: "public",
          parameters: "[]",
          returnType: null,
        },
      },
      {
        id: "file:routes.ts:function:10:authenticate",
        label: "Function",
        properties: {
          name: "authenticate",
          kind: "function_declaration",
          methodKind: null,
          line: 10,
          endLine: 12,
          className: null,
          isExported: false,
          isAsync: false,
          isAbstract: false,
          visibility: "public",
          parameters: "[]",
          returnType: null,
        },
      },
      {
        id: "file:routes.ts:variable:1:app",
        label: "Variable",
        properties: {
          name: "app",
          kind: "const",
          isExported: false,
          line: 1,
        },
      },
      {
        id: "file:routes.ts:variable:2:router",
        label: "Variable",
        properties: {
          name: "router",
          kind: "const",
          isExported: false,
          line: 2,
        },
      },
      {
        id: "file:routes.ts:route:7:get:/users",
        label: "Route",
        properties: {
          method: "GET",
          path: "/users",
          line: 7,
          framework: "express",
          handlerName: "listUsers",
        },
      },
    ];
    const relationships: GraphRelationship[] = [
      {
        from: "file:routes.ts",
        to: "file:routes.ts:route:7:get:/users",
        type: "DECLARES_ROUTE",
        properties: {},
      },
      {
        from: "file:routes.ts:route:7:get:/users",
        to: "file:routes.ts:function:3:listUsers",
        type: "ROUTE_HANDLED_BY",
        properties: {},
      },
      {
        from: "file:routes.ts:variable:1:app",
        to: "file:routes.ts:variable:2:router",
        type: "MOUNTS",
        properties: {
          path: "/api",
          line: 14,
        },
      },
      {
        from: "file:routes.ts:variable:2:router",
        to: "file:routes.ts:function:10:authenticate",
        type: "MOUNTS",
        properties: {
          path: null,
          line: 15,
        },
      },
    ];

    await writer.write(nodes, relationships);

    assert.equal(await writer.schemaVersion(), SCHEMA_VERSION);

    const stats = await writer.stats();
    assert.equal(stats.find((row) => row.table === "Route")?.count, 1);

    const routeRows = await writer.query(
      "MATCH (f:File)-[:DECLARES_ROUTE]->(r:Route)-[:ROUTE_HANDLED_BY]->(fn:Function) RETURN r.method AS method, r.path AS path, r.framework AS framework, fn.name AS handlerName",
    );
    assert.deepEqual(routeRows, [
      {
        method: "GET",
        path: "/users",
        framework: "express",
        handlerName: "listUsers",
      },
    ]);

    const variableMountRows = await writer.query(
      "MATCH (source:Variable)-[m:MOUNTS_VARIABLE]->(target:Variable) RETURN source.name AS source, target.name AS target, m.path AS path, m.line AS line",
    );
    assert.deepEqual(variableMountRows, [
      {
        source: "app",
        target: "router",
        path: "/api",
        line: 14,
      },
    ]);

    const functionMountRows = await writer.query(
      "MATCH (source:Variable)-[m:MOUNTS_FUNCTION]->(target:Function) RETURN source.name AS source, target.name AS target, m.path AS path, m.line AS line",
    );
    assert.deepEqual(functionMountRows, [
      {
        source: "router",
        target: "authenticate",
        path: null,
        line: 15,
      },
    ]);

    await writer.close();
  });
});
