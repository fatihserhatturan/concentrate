import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { SCHEMA_VERSION } from "../src/adapters/kuzu/schema.js";
import { KuzuGraphWriter } from "../src/adapters/kuzu/kuzu-writer.js";

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
          sourceType: "production",
          isTest: false,
          isFixture: false,
          isSupport: false,
          isGenerated: false,
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
        id: "file:routes.ts:function:13:validate",
        label: "Function",
        properties: {
          name: "validate",
          kind: "function_declaration",
          methodKind: null,
          line: 13,
          endLine: 15,
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
          stringValue: null,
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
          stringValue: null,
        },
      },
      {
        id: "file:routes.ts:route:7:get:/users",
        label: "Route",
        properties: {
          method: "GET",
          path: "/users",
          fullPath: "/api/users",
          pathExpression: "'/users'",
          receiverName: "router",
          line: 7,
          framework: "express",
          handlerName: "listUsers",
        },
      },
      {
        id: "file:routes.ts:entrypoint:20:0:event:data",
        label: "EntryPoint",
        properties: {
          kind: "event",
          trigger: "data",
          receiverName: "emitter",
          library: "event-emitter",
          line: 20,
          handlerName: "listUsers",
        },
      },
      {
        id: "env:DATABASE_URL",
        label: "EnvVar",
        properties: {
          name: "DATABASE_URL",
        },
      },
      {
        id: "datamodel:prisma:user",
        label: "DataModel",
        properties: {
          name: "user",
          library: "prisma",
        },
      },
      {
        id: "file:routes.ts:config:1:FEATURE_FLAG",
        label: "ConfigValue",
        properties: {
          name: "FEATURE_FLAG",
          value: "users",
          valueType: "string",
          line: 1,
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
        from: "file:routes.ts",
        to: "file:routes.ts:entrypoint:20:0:event:data",
        type: "DECLARES_ENTRYPOINT",
        properties: {},
      },
      {
        from: "file:routes.ts:entrypoint:20:0:event:data",
        to: "file:routes.ts:function:3:listUsers",
        type: "ENTRYPOINT_HANDLED_BY",
        properties: {},
      },
      {
        from: "file:routes.ts:route:7:get:/users",
        to: "file:routes.ts:function:10:authenticate",
        type: "ROUTE_LIFECYCLE_STEP",
        properties: {
          role: "middleware",
          scope: "route",
          hook: null,
          orderIndex: 0,
        },
      },
      {
        from: "file:routes.ts:route:7:get:/users",
        to: "file:routes.ts:function:13:validate",
        type: "ROUTE_LIFECYCLE_STEP",
        properties: {
          role: "middleware",
          scope: "route",
          hook: null,
          orderIndex: 1,
        },
      },
      {
        from: "file:routes.ts:function:10:authenticate",
        to: "file:routes.ts:function:13:validate",
        type: "LIFECYCLE_PRECEDES",
        properties: {
          routeId: "file:routes.ts:route:7:get:/users",
          scope: "route",
          orderIndex: 0,
        },
      },
      {
        from: "file:routes.ts",
        to: "env:DATABASE_URL",
        type: "USES_ENV",
        properties: {
          line: 8,
          access: "subscript",
        },
      },
      {
        from: "file:routes.ts:function:3:listUsers",
        to: "env:DATABASE_URL",
        type: "USES_ENV",
        properties: {
          line: 4,
          access: "subscript",
        },
      },
      {
        from: "file:routes.ts:route:7:get:/users",
        to: "env:DATABASE_URL",
        type: "USES_ENV",
        properties: {
          line: 4,
          access: "subscript",
        },
      },
      {
        from: "file:routes.ts:function:3:listUsers",
        to: "datamodel:prisma:user",
        type: "ACCESSES_DATA",
        properties: {
          operation: "read",
          library: "prisma",
          line: 5,
          expression: "prisma.user.findMany",
        },
      },
      {
        from: "file:routes.ts:route:7:get:/users",
        to: "datamodel:prisma:user",
        type: "ACCESSES_DATA",
        properties: {
          operation: "read",
          library: "prisma",
          line: 5,
          expression: "prisma.user.findMany",
        },
      },
      {
        from: "file:routes.ts",
        to: "file:routes.ts:config:1:FEATURE_FLAG",
        type: "DECLARES_CONFIG",
        properties: {},
      },
      {
        from: "file:routes.ts",
        to: "file:routes.ts:config:1:FEATURE_FLAG",
        type: "CONSUMES_CONFIG",
        properties: {
          localName: "FEATURE_FLAG",
        },
      },
      {
        from: "file:routes.ts:variable:1:app",
        to: "file:routes.ts:variable:2:router",
        type: "MOUNTS",
        properties: {
          path: "/api",
          pathExpression: "'/api'",
          line: 14,
        },
      },
      {
        from: "file:routes.ts:variable:2:router",
        to: "file:routes.ts:function:10:authenticate",
        type: "MOUNTS",
        properties: {
          path: null,
          pathExpression: null,
          line: 15,
        },
      },
    ];

    await writer.write(nodes, relationships);

    assert.equal(await writer.schemaVersion(), SCHEMA_VERSION);

    const stats = await writer.stats();
    assert.equal(stats.find((row) => row.table === "Route")?.count, 1);
    assert.equal(stats.find((row) => row.table === "EntryPoint")?.count, 1);
    assert.equal(stats.find((row) => row.table === "EnvVar")?.count, 1);
    assert.equal(stats.find((row) => row.table === "ConfigValue")?.count, 1);
    assert.equal(stats.find((row) => row.table === "DataModel")?.count, 1);

    const routeRows = await writer.query(
      "MATCH (f:File)-[:DECLARES_ROUTE]->(r:Route)-[:ROUTE_HANDLED_BY]->(fn:Function) RETURN r.method AS method, r.path AS path, r.fullPath AS fullPath, r.framework AS framework, fn.name AS handlerName",
    );
    assert.deepEqual(routeRows, [
      {
        method: "GET",
        path: "/users",
        fullPath: "/api/users",
        framework: "express",
        handlerName: "listUsers",
      },
    ]);

    const fileRows = await writer.query(
      "MATCH (f:File) RETURN f.relativePath AS relativePath, f.sourceType AS sourceType, f.isTest AS isTest, f.isFixture AS isFixture, f.isSupport AS isSupport, f.isGenerated AS isGenerated",
    );
    assert.deepEqual(fileRows, [
      {
        relativePath: "routes.ts",
        sourceType: "production",
        isTest: false,
        isFixture: false,
        isSupport: false,
        isGenerated: false,
      },
    ]);

    const lifecycleRows = await writer.query(
      "MATCH (r:Route)-[step:ROUTE_LIFECYCLE_STEP]->(fn:Function) RETURN fn.name AS name, step.role AS role, step.scope AS scope, step.hook AS hook, step.orderIndex AS orderIndex ORDER BY step.orderIndex",
    );
    assert.deepEqual(lifecycleRows, [
      {
        name: "authenticate",
        role: "middleware",
        scope: "route",
        hook: null,
        orderIndex: 0,
      },
      {
        name: "validate",
        role: "middleware",
        scope: "route",
        hook: null,
        orderIndex: 1,
      },
    ]);

    const entrypointRows = await writer.query(
      "MATCH (f:File)-[:DECLARES_ENTRYPOINT]->(e:EntryPoint)-[:ENTRYPOINT_HANDLED_BY]->(fn:Function) RETURN e.kind AS kind, e.trigger AS trigger, e.library AS library, fn.name AS handlerName",
    );
    assert.deepEqual(entrypointRows, [
      {
        kind: "event",
        trigger: "data",
        library: "event-emitter",
        handlerName: "listUsers",
      },
    ]);

    const lifecycleOrderRows = await writer.query(
      "MATCH (first:Function)-[rel:LIFECYCLE_PRECEDES]->(second:Function) RETURN first.name AS first, second.name AS second, rel.routeId AS routeId, rel.scope AS scope, rel.orderIndex AS orderIndex",
    );
    assert.deepEqual(lifecycleOrderRows, [
      {
        first: "authenticate",
        second: "validate",
        routeId: "file:routes.ts:route:7:get:/users",
        scope: "route",
        orderIndex: 0,
      },
    ]);

    const functionEnvRows = await writer.query(
      "MATCH (fn:Function)-[rel:USES_ENV_FUNCTION]->(env:EnvVar) RETURN fn.name AS functionName, env.name AS envName, rel.access AS access",
    );
    assert.deepEqual(functionEnvRows, [
      {
        functionName: "listUsers",
        envName: "DATABASE_URL",
        access: "subscript",
      },
    ]);

    const routeEnvRows = await writer.query(
      "MATCH (route:Route)-[rel:USES_ENV_ROUTE]->(env:EnvVar) RETURN route.path AS path, env.name AS envName, rel.access AS access",
    );
    assert.deepEqual(routeEnvRows, [
      {
        path: "/users",
        envName: "DATABASE_URL",
        access: "subscript",
      },
    ]);

    const configRows = await writer.query(
      "MATCH (file:File)-[:DECLARES_CONFIG_FILE]->(config:ConfigValue) RETURN config.name AS name, config.value AS value, config.valueType AS valueType",
    );
    assert.deepEqual(configRows, [
      {
        name: "FEATURE_FLAG",
        value: "users",
        valueType: "string",
      },
    ]);

    const dataAccessRows = await writer.query(
      "MATCH (route:Route)-[rel:ACCESSES_DATA_ROUTE]->(model:DataModel) RETURN route.path AS path, model.name AS model, model.library AS modelLibrary, rel.operation AS operation, rel.library AS accessLibrary",
    );
    assert.deepEqual(dataAccessRows, [
      {
        path: "/users",
        model: "user",
        modelLibrary: "prisma",
        operation: "read",
        accessLibrary: "prisma",
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
