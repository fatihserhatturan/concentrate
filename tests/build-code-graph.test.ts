import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/scanner/build-code-graph.js";
import { scanCommand } from "../src/commands/scan.js";
import { KuzuGraphWriter } from "../src/graph/kuzu-writer.js";
import { SCHEMA_VERSION } from "../src/graph/schema.js";
import { getLanguageParser } from "../src/parsers/index.js";
import { parseTsconfig } from "../src/scanner/resolution/tsconfig.js";
import type { GraphNode, GraphRelationship, GraphNodeLabel, GraphRelationshipType } from "../src/graph/model.js";

const fixturesRoot = path.resolve("fixtures");

describe("buildCodeGraph", () => {
  it("registers language parsers through the parser registry", () => {
    assert.equal(getLanguageParser("javascript").language, "javascript");
    assert.equal(getLanguageParser("typescript").language, "typescript");
    assert.equal(getLanguageParser("python").language, "python");
    assert.equal(getLanguageParser("go").language, "go");
    assert.equal(getLanguageParser("rust").language, "rust");
  });

  it("resolves relative JS imports to TypeScript source files", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "import-resolution"), {
      continueOnError: false,
    });

    assert.equal(graph.report.discoveredFiles, 2);
    assert.equal(graph.report.supportedFiles, 2);
    assert.equal(graph.report.parsedFiles, 2);
    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 1);
    assert.equal(graph.report.unresolvedRelativeImports, 0);

    assertNodeCount(graph.nodes, "File", 2);
    assertNodeCount(graph.nodes, "Import", 1);
    assertRelationship(
      graph.relationships,
      "file:index.ts:import:1:./utils.js",
      "RESOLVES_TO",
      "file:utils.ts",
    );
  });

  it("keeps nested function calls attached to their own function", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "call-graph"), {
      continueOnError: false,
    });

    const callsByFunction = new Map<string, string[]>();
    for (const relationship of graph.relationships.filter((item) => item.type === "CALLS")) {
      const functionNode = getNode(graph.nodes, relationship.from);
      const callNode = getNode(graph.nodes, relationship.to);
      const functionName = String(functionNode.properties.name);
      const callExpression = String(callNode.properties.expression);
      callsByFunction.set(functionName, [...(callsByFunction.get(functionName) ?? []), callExpression]);
    }

    assert.deepEqual(callsByFunction.get("outer")?.sort(), ["finish", "setup"]);
    assert.deepEqual(callsByFunction.get("inner"), ["nestedOnly"]);
  });

  it("continues after syntax errors when requested", async () => {
    const fixturePath = await createScanErrorFixture();
    const graph = await buildCodeGraph(fixturePath, {
      continueOnError: true,
    });

    assert.equal(graph.report.discoveredFiles, 2);
    assert.equal(graph.report.supportedFiles, 2);
    assert.equal(graph.report.parsedFiles, 1);
    assert.equal(graph.report.status, "partial");
    assert.equal(graph.report.failedFiles.length, 1);
    assert.equal(graph.report.failedFiles[0]?.path, "bad.ts");
    assert.match(graph.report.failedFiles[0]?.message ?? "", /Syntax error/);

    assertRelationship(
      graph.relationships,
      "file:good.ts",
      "DEFINES_FUNCTION",
      "file:good.ts:function:1:good",
    );
  });

  it("writes partial Kuzu graphs when continue-on-error is enabled", async () => {
    const fixturePath = await createScanErrorFixture();
    const databasePath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "concentrate-partial-graph-")),
      "graph.kuzu",
    );
    const previousExitCode = process.exitCode;

    await scanCommand(fixturePath, {
      database: databasePath,
      continueOnError: true,
      include: [],
      exclude: [],
      kuzuWriteMode: "transaction",
    });

    assert.equal(process.exitCode, 1);
    process.exitCode = previousExitCode;

    const writer = await KuzuGraphWriter.open(databasePath);
    try {
      assert.equal(await writer.schemaVersion(), SCHEMA_VERSION);
      const rows = await writer.query(
        "MATCH (f:File)-[:DEFINES_FUNCTION]->(fn:Function) RETURN f.relativePath AS path, fn.name AS name",
      );
      assert.deepEqual(rows, [
        {
          path: "good.ts",
          name: "good",
        },
      ]);
    } finally {
      await writer.close();
    }
  });

  it("extracts Python files, imports, classes, functions, calls, and relative import resolution", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "python-basic"), {
      continueOnError: false,
    });

    assert.equal(graph.report.discoveredFiles, 2);
    assert.equal(graph.report.supportedFiles, 2);
    assert.equal(graph.report.parsedFiles, 2);
    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 1);

    assertNodeCount(graph.nodes, "File", 2);
    assertNodeCount(graph.nodes, "Import", 1);
    assertNodeCount(graph.nodes, "Class", 1);
    assert.equal(
      graph.nodes.filter((node) => node.label === "Function").length,
      5,
    );
    assertRelationship(
      graph.relationships,
      "file:main.py:import:1:./utils",
      "RESOLVES_TO",
      "file:utils.py",
    );

    assertRelationship(
      graph.relationships,
      "file:main.py:class:12:Service",
      "DEFINES_METHOD",
      "file:main.py:function:13:run",
    );

    assertRelationship(
      graph.relationships,
      "file:main.py",
      "DEFINES_FUNCTION",
      "file:main.py:function:4:main",
    );

    assertRelationship(
      graph.relationships,
      "file:main.py",
      "DEFINES_FUNCTION",
      "file:main.py:function:8:fetch",
    );

    assert.equal(graph.nodes.find((n) => n.properties.name === "run")?.properties.className, "Service");
    assert.equal(graph.nodes.find((n) => n.properties.name === "main")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "fetch")?.properties.isAsync, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "helper")?.properties.isAsync, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "run")?.properties.isAsync, false);
    assert.equal(graph.nodes.find((n) => n.properties.name === "Service" && n.label === "Class")?.properties.isExported, true);

    const serviceRunCalls = callsForFunction(graph.nodes, graph.relationships, "run");
    assert.deepEqual(serviceRunCalls, ["self.helper"]);
  });

  it("resolves richer Python import forms", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "python-imports"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 4);
    assert.equal(graph.report.unresolvedRelativeImports, 0);

    assertRelationship(
      graph.relationships,
      "file:app/main.py:import:1:./utils",
      "RESOLVES_TO",
      "file:app/utils.py",
    );
    assertRelationship(
      graph.relationships,
      "file:app/main.py:import:2:./../core",
      "RESOLVES_TO",
      "file:core.py",
    );
    assertRelationship(
      graph.relationships,
      "file:app/main.py:import:3:pkg.module",
      "RESOLVES_TO",
      "file:pkg/module.py",
    );
    assertRelationship(
      graph.relationships,
      "file:app/main.py:import:4:pkg.nested",
      "RESOLVES_TO",
      "file:pkg/nested/__init__.py",
    );
  });

  it("resolves TS path aliases and baseUrl imports", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "ts-paths"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 3);
    assert.equal(graph.report.unresolvedRelativeImports, 0);

    assertRelationship(
      graph.relationships,
      "file:src/index.ts:import:1:@/utils/format.js",
      "RESOLVES_TO",
      "file:src/utils/format.ts",
    );
    assertRelationship(
      graph.relationships,
      "file:src/index.ts:import:2:@lib/helper",
      "RESOLVES_TO",
      "file:src/lib/helper.ts",
    );
    assertRelationship(
      graph.relationships,
      "file:src/index.ts:import:3:src/internal",
      "RESOLVES_TO",
      "file:src/internal.ts",
    );
  });

  it("parses tsconfig globs and trailing commas without treating them as comments", () => {
    const parsed = parseTsconfig(`{
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@/*": ["src/*"],
          "@app/*": ["app/*"],
        }
      },
      "exclude": ["node_modules", "**/*.spec.ts"] // ordinary JSONC comment
    }`);

    assert.equal(parsed.baseUrl, ".");
    assert.deepEqual(parsed.paths, [
      { pattern: "@/*", targets: ["src/*"] },
      { pattern: "@app/*", targets: ["app/*"] },
    ]);
  });

  it("keeps scanning when project config files are malformed and reports warnings", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "malformed-config"), {
      continueOnError: false,
    });

    assert.equal(graph.report.status, "success");
    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 1);
    assert.equal(graph.report.warnings.length, 3);
    assert.ok(graph.report.warnings.some((warning) => warning.path === "package.json"));
    assert.ok(graph.report.warnings.some((warning) => warning.path === "tsconfig.json"));
    assertRelationship(
      graph.relationships,
      "file:index.ts",
      "DEFINES_FUNCTION",
      "file:index.ts:function:1:main",
    );
  });

  it("resolves Go project-internal imports via go.mod module name", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "go-import"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 2);
    assert.equal(graph.report.resolvedImports, 1);
    assert.equal(graph.report.unresolvedRelativeImports, 0);

    assertRelationship(
      graph.relationships,
      "file:main.go:import:5:example.com/myapp/internal/service",
      "RESOLVES_TO",
      "file:internal/service/service.go",
    );
  });

  it("extracts Go files, imports, structs, functions, methods, and calls", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "go-basic"), {
      continueOnError: false,
    });

    assert.equal(graph.report.discoveredFiles, 1);
    assert.equal(graph.report.supportedFiles, 1);
    assert.equal(graph.report.parsedFiles, 1);
    assert.equal(graph.report.failedFiles.length, 0);

    assertNodeCount(graph.nodes, "File", 1);
    assertNodeCount(graph.nodes, "Import", 2);
    assertNodeCount(graph.nodes, "Class", 1);
    assert.equal(
      graph.nodes.filter((node) => node.label === "Function").length,
      2,
    );

    assertRelationship(
      graph.relationships,
      "file:service.go",
      "DEFINES_CLASS",
      "file:service.go:class:8:Service",
    );

    assertRelationship(
      graph.relationships,
      "file:service.go:class:8:Service",
      "DEFINES_METHOD",
      "file:service.go:function:16:Run",
    );

    assertRelationship(
      graph.relationships,
      "file:service.go",
      "DEFINES_FUNCTION",
      "file:service.go:function:12:NewService",
    );

    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "NewService"), ["strings.TrimSpace"]);
    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "Run"), ["fmt.Println"]);
    assert.equal(graph.nodes.find((n) => n.properties.name === "Run")?.properties.className, "Service");
    assert.equal(graph.nodes.find((n) => n.properties.name === "Run")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "NewService")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "Run")?.properties.isAsync, false);
    assert.equal(graph.nodes.find((n) => n.properties.name === "Service" && n.label === "Class")?.properties.isExported, true);
  });

  it("resolves Rust crate:: and super:: imports to local .rs files", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "rust-import"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 3);
    assert.equal(graph.report.resolvedImports, 4);
    assert.equal(graph.report.unresolvedRelativeImports, 0);

    // mod utils; in lib.rs → utils.rs
    assertRelationship(
      graph.relationships,
      "file:lib.rs:import:1:utils",
      "RESOLVES_TO",
      "file:utils.rs",
    );

    // mod helpers; in lib.rs → helpers/mod.rs
    assertRelationship(
      graph.relationships,
      "file:lib.rs:import:2:helpers",
      "RESOLVES_TO",
      "file:helpers/mod.rs",
    );

    // use crate::utils::process; in lib.rs → utils.rs
    assertRelationship(
      graph.relationships,
      "file:lib.rs:import:3:crate::utils::process",
      "RESOLVES_TO",
      "file:utils.rs",
    );

    // use super::utils; in helpers/mod.rs → utils.rs
    assertRelationship(
      graph.relationships,
      "file:helpers/mod.rs:import:1:super::utils",
      "RESOLVES_TO",
      "file:utils.rs",
    );
  });

  it("extracts Rust files, imports, structs, functions, impl methods, and calls", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "rust-basic"), {
      continueOnError: false,
    });

    assert.equal(graph.report.discoveredFiles, 2);
    assert.equal(graph.report.supportedFiles, 2);
    assert.equal(graph.report.parsedFiles, 2);
    assert.equal(graph.report.failedFiles.length, 0);

    assertNodeCount(graph.nodes, "File", 2);
    assertNodeCount(graph.nodes, "Import", 2);
    assertNodeCount(graph.nodes, "Class", 1);
    assert.equal(
      graph.nodes.filter((node) => node.label === "Function").length,
      6,
    );

    assertRelationship(
      graph.relationships,
      "file:lib.rs",
      "DEFINES_CLASS",
      "file:lib.rs:class:4:Service",
    );

    assertRelationship(
      graph.relationships,
      "file:lib.rs:class:4:Service",
      "DEFINES_METHOD",
      "file:lib.rs:function:9:new",
    );

    assertRelationship(
      graph.relationships,
      "file:lib.rs:class:4:Service",
      "DEFINES_METHOD",
      "file:lib.rs:function:13:run",
    );

    assertRelationship(
      graph.relationships,
      "file:lib.rs",
      "DEFINES_FUNCTION",
      "file:lib.rs:function:23:make",
    );

    assert.equal(
      graph.nodes.find((n) => n.properties.name === "new")?.properties.className,
      "Service",
    );

    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "new"), ["format"]);
    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "run"), ["println", "self.helper"]);
    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "make"), ["Service::new", "String::new"]);
    assert.equal(graph.nodes.find((n) => n.properties.name === "make")?.properties.isExported, false);
    assert.equal(graph.nodes.find((n) => n.properties.name === "fetch")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "fetch")?.properties.isAsync, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "make")?.properties.isAsync, false);
    assert.equal(graph.nodes.find((n) => n.properties.name === "Service" && n.label === "Class")?.properties.isExported, false);
  });

  it("attributes TypeScript class methods to their class via DEFINES_METHOD", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "ts-class"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    assertNodeCount(graph.nodes, "Class", 1);
    assertRelationship(
      graph.relationships,
      "file:service.ts",
      "DEFINES_CLASS",
      "file:service.ts:class:1:UserService",
    );

    assertRelationship(
      graph.relationships,
      "file:service.ts:class:1:UserService",
      "DEFINES_METHOD",
      "file:service.ts:function:2:greet",
    );

    assertRelationship(
      graph.relationships,
      "file:service.ts:class:1:UserService",
      "DEFINES_METHOD",
      "file:service.ts:function:6:format",
    );

    assertRelationship(
      graph.relationships,
      "file:service.ts",
      "DEFINES_FUNCTION",
      "file:service.ts:function:11:standalone",
    );

    assertRelationship(
      graph.relationships,
      "file:service.ts",
      "DEFINES_FUNCTION",
      "file:service.ts:function:15:fetchUser",
    );

    assert.equal(graph.nodes.find((n) => n.properties.name === "greet")?.properties.className, "UserService");
    assert.equal(graph.nodes.find((n) => n.properties.name === "greet")?.properties.isAsync, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "format")?.properties.isAsync, false);
    assert.equal(graph.nodes.find((n) => n.properties.name === "format")?.properties.visibility, "private");
    assert.equal(graph.nodes.find((n) => n.properties.name === "UserService" && n.label === "Class")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "UserService" && n.label === "Class")?.properties.visibility, "public");
    assert.equal(graph.nodes.find((n) => n.properties.name === "standalone")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "fetchUser")?.properties.isAsync, true);
    assert.equal(graph.nodes.find((n) => n.properties.name === "fetchUser")?.properties.isExported, true);
  });

  it("resolves call expressions to their target function nodes", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "call-resolution"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 2);

    // same-file: run() calls helper() — both in main.ts
    const helperNode = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "helper")!;
    const runCallNodes = graph.relationships
      .filter((r) => r.type === "CALLS")
      .filter((r) => {
        const fn = graph.nodes.find((n) => n.id === r.from);
        return fn?.properties.name === "run";
      })
      .map((r) => r.to);

    const helperCallId = runCallNodes.find((callId) => {
      const call = graph.nodes.find((n) => n.id === callId);
      return call?.properties.callee === "helper";
    });
    assert.ok(helperCallId, "Expected a Call node for helper()");
    assertRelationship(graph.relationships, helperCallId, "CALL_RESOLVES_TO", helperNode.id);

    // cross-file via namespace import: run() calls MathUtils.multiply(2,3) → multiply in utils.ts
    const multiplyNode = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "multiply")!;
    const multiplyCallId = runCallNodes.find((callId) => {
      const call = graph.nodes.find((n) => n.id === callId);
      return call?.properties.callee === "multiply";
    });
    assert.ok(multiplyCallId, "Expected a Call node for multiply()");
    assertRelationship(graph.relationships, multiplyCallId, "CALL_RESOLVES_TO", multiplyNode.id);

    // cross-file via named import (no receiver): run() calls add(1,2) → add in utils.ts
    const addNode = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "add")!;
    const addCallId = runCallNodes.find((callId) => {
      const call = graph.nodes.find((n) => n.id === callId);
      return call?.properties.callee === "add" && !call.properties.receiver;
    });
    assert.ok(addCallId, "Expected a Call node for add()");
    assertRelationship(graph.relationships, addCallId, "CALL_RESOLVES_TO", addNode.id);
  });

  it("extracts arrow functions and function expressions in TypeScript", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "arrow-functions"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const functionNodes = graph.nodes.filter((n) => n.label === "Function");
    const functionNames = functionNodes.map((n) => String(n.properties.name)).sort();
    assert.deepEqual(functionNames, ["fetchData", "greet", "inner", "multiply", "outer"]);

    const greet = functionNodes.find((n) => n.properties.name === "greet")!;
    assert.equal(greet.properties.kind, "arrow_function");

    const fetchData = functionNodes.find((n) => n.properties.name === "fetchData")!;
    assert.equal(fetchData.properties.kind, "arrow_function");

    const multiply = functionNodes.find((n) => n.properties.name === "multiply")!;
    assert.equal(multiply.properties.kind, "function_expression");

    const outer = functionNodes.find((n) => n.properties.name === "outer")!;
    assert.equal(outer.properties.kind, "function_declaration");

    // calls inside inner (arrow) must not leak into outer
    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "outer"), ["inner"]);
    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "inner"), ["String"]);
  });

  it("resolves class inheritance and interface implementation relationships", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "inheritance"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const httpClient = graph.nodes.find((n) => n.label === "Class" && n.properties.name === "HttpClient")!;
    const baseClient = graph.nodes.find((n) => n.label === "Class" && n.properties.name === "BaseClient")!;
    const retryable = graph.nodes.find((n) => n.label === "Interface" && n.properties.name === "Retryable")!;
    const userService = graph.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService")!;
    const baseService = graph.nodes.find((n) => n.label === "Class" && n.properties.name === "BaseService")!;

    assert.ok(httpClient);
    assert.ok(baseClient);
    assert.ok(retryable);
    assert.ok(userService);
    assert.ok(baseService);

    assertRelationship(graph.relationships, httpClient.id, "EXTENDS", baseClient.id);
    assertRelationship(graph.relationships, httpClient.id, "IMPLEMENTS", retryable.id);
    assertRelationship(graph.relationships, userService.id, "EXTENDS", baseService.id);
  });

  it("tracks JS/TS re-exports and resolves their target files", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "re-exports"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 2);
    assert.equal(graph.report.unresolvedRelativeImports, 0);

    const namedReExport = graph.nodes.find((n) => (
      n.label === "Import" && n.properties.source === "./client.js"
    ));
    const wildcardReExport = graph.nodes.find((n) => (
      n.label === "Import" && n.properties.source === "./errors.js"
    ));

    assert.ok(namedReExport);
    assert.ok(wildcardReExport);
    assert.equal(namedReExport.properties.isReExport, true);
    assert.equal(namedReExport.properties.isWildcard, false);
    assert.equal(wildcardReExport.properties.isReExport, true);
    assert.equal(wildcardReExport.properties.isWildcard, true);

    assertRelationship(graph.relationships, "file:index.ts", "IMPORTS", namedReExport.id);
    assertRelationship(graph.relationships, namedReExport.id, "RESOLVES_TO", "file:client.ts");
    assertRelationship(graph.relationships, "file:index.ts", "IMPORTS", wildcardReExport.id);
    assertRelationship(graph.relationships, wildcardReExport.id, "RESOLVES_TO", "file:errors.ts");
    assertRelationship(graph.relationships, "file:index.ts", "RE_EXPORTS", wildcardReExport.id);
  });

  it("tracks local named re-exports to same-file definitions", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "local-re-exports"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 0);

    const createClient = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "createClient")!;
    const localClient = graph.nodes.find((n) => n.label === "Class" && n.properties.name === "LocalClient")!;
    const defaultTimeout = graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "defaultTimeout")!;
    const ignoredSetting = graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "ignoredSetting")!;

    assert.ok(createClient);
    assert.ok(localClient);
    assert.ok(defaultTimeout);
    assert.ok(ignoredSetting);
    assertRelationship(graph.relationships, "file:index.ts", "RE_EXPORTS", createClient.id);
    assertRelationship(graph.relationships, "file:index.ts", "RE_EXPORTS", localClient.id);
    assertRelationship(graph.relationships, "file:index.ts", "RE_EXPORTS", defaultTimeout.id);
    assert.ok(!graph.relationships.some((r) => r.from === "file:index.ts" && r.to === ignoredSetting.id && r.type === "RE_EXPORTS"));
  });

  it("captures dynamic imports and resolves them via the existing pipeline", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "dynamic-imports"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 3);

    // Two string-literal dynamic imports must be captured
    const dynamicImports = graph.nodes.filter(
      (n) => n.label === "Import" && n.properties.isDynamic === true,
    );
    assert.equal(dynamicImports.length, 2, "Expected 2 dynamic Import nodes");

    const utilsImport = dynamicImports.find((n) => n.properties.source === "./utils");
    const pageImport = dynamicImports.find((n) => n.properties.source === "./page");
    assert.ok(utilsImport, "Dynamic import of ./utils");
    assert.ok(pageImport, "Dynamic import of ./page");

    // bindings must be null — dynamic imports carry no named specifiers
    assert.equal(utilsImport!.properties.bindings, null);
    assert.equal(pageImport!.properties.bindings, null);

    // Both must resolve to their target files
    assert.equal(graph.report.resolvedImports, 2);
    assertRelationship(graph.relationships, utilsImport!.id, "RESOLVES_TO", "file:utils.ts");
    assertRelationship(graph.relationships, pageImport!.id, "RESOLVES_TO", "file:page.ts");

    // Variable-specifier import(path) must NOT produce an Import node
    const variableImport = graph.nodes.find(
      (n) => n.label === "Import" && n.properties.source === "path",
    );
    assert.equal(variableImport, undefined, "Variable-specifier import must not be captured");

    // Static imports in the same codebase must have isDynamic: false
    const staticImports = graph.nodes.filter(
      (n) => n.label === "Import" && n.properties.isDynamic === false,
    );
    assert.equal(staticImports.length, 0, "No static imports in this fixture");
  });

  it("extracts named import bindings and resolves aliased calls to the correct target", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "named-imports"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 3);
    assert.equal(graph.report.resolvedImports, 3);

    // --- binding extraction ---
    const namedImport = graph.nodes.find(
      (n) => n.label === "Import" && n.properties.source === "./utils-a" && !n.properties.isReExport,
    )!;
    const aliasedImport = graph.nodes.find(
      (n) => n.label === "Import" && n.properties.source === "./utils-b",
    )!;
    const namespaceImport = graph.nodes.find(
      (n) => n.label === "Import" && n.properties.source === "./utils-a" && !n.properties.isReExport
        && (n.properties.bindings as string ?? "").includes("namespace"),
    )!;

    assert.ok(namedImport, "named import from utils-a");
    assert.ok(aliasedImport, "aliased import from utils-b");
    assert.ok(namespaceImport, "namespace import from utils-a");

    const namedBindings = JSON.parse(namedImport.properties.bindings as string);
    assert.deepEqual(namedBindings, [{ imported: "format", local: "format", kind: "named" }]);

    const aliasedBindings = JSON.parse(aliasedImport.properties.bindings as string);
    assert.deepEqual(aliasedBindings, [{ imported: "format", local: "fmt", kind: "named" }]);

    const nsBindings = JSON.parse(namespaceImport.properties.bindings as string);
    assert.deepEqual(nsBindings, [{ imported: "*", local: "A", kind: "namespace" }]);

    // --- call resolution ---
    const runCallIds = graph.relationships
      .filter((r) => r.type === "CALLS")
      .filter((r) => graph.nodes.find((n) => n.id === r.from)?.properties.name === "run")
      .map((r) => r.to);

    const formatANode = graph.nodes.find(
      (n) => n.label === "Function" && n.properties.name === "format"
        && (n.id as string).includes("utils-a"),
    )!;
    const formatBNode = graph.nodes.find(
      (n) => n.label === "Function" && n.properties.name === "format"
        && (n.id as string).includes("utils-b"),
    )!;
    const parseNode = graph.nodes.find(
      (n) => n.label === "Function" && n.properties.name === "parse",
    )!;

    assert.ok(formatANode, "format in utils-a");
    assert.ok(formatBNode, "format in utils-b");
    assert.ok(parseNode, "parse in utils-a");

    // format('hello') → utils-a's format (not utils-b's)
    const formatCallId = runCallIds.find((id) => {
      const call = graph.nodes.find((n) => n.id === id);
      return call?.properties.callee === "format" && !call.properties.receiver;
    });
    assert.ok(formatCallId, "Call node for format()");
    assertRelationship(graph.relationships, formatCallId, "CALL_RESOLVES_TO", formatANode.id);
    assert.ok(
      !graph.relationships.some((r) => r.from === formatCallId && r.to === formatBNode.id),
      "format() must NOT resolve to utils-b",
    );

    // fmt('world') → utils-b's format (via alias)
    const fmtCallId = runCallIds.find((id) => {
      const call = graph.nodes.find((n) => n.id === id);
      return call?.properties.callee === "fmt";
    });
    assert.ok(fmtCallId, "Call node for fmt()");
    assertRelationship(graph.relationships, fmtCallId, "CALL_RESOLVES_TO", formatBNode.id);

    // A.parse('42') → utils-a's parse (via namespace)
    const parseCallId = runCallIds.find((id) => {
      const call = graph.nodes.find((n) => n.id === id);
      return call?.properties.callee === "parse" && call.properties.receiver === "A";
    });
    assert.ok(parseCallId, "Call node for A.parse()");
    assertRelationship(graph.relationships, parseCallId, "CALL_RESOLVES_TO", parseNode.id);
  });

  it("resolves package.json exports, main, and types fields for JS/TS package imports", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "package-boundary"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 3);
    assert.equal(graph.report.unresolvedRelativeImports, 0);

    assertRelationship(
      graph.relationships,
      "file:app.ts:import:1:@sample/pkg",
      "RESOLVES_TO",
      "file:source/index.ts",
    );
    assertRelationship(
      graph.relationships,
      "file:app.ts:import:2:@sample/pkg/feature",
      "RESOLVES_TO",
      "file:source/feature.ts",
    );
    assertRelationship(
      graph.relationships,
      "file:app.ts:import:3:@sample/pkg/utils/math",
      "RESOLVES_TO",
      "file:source/utils/math.ts",
    );
  });

  it("models workspace packages and links files, config, and internal imports", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "workspace-monorepo"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 1);
    assertNodeCount(graph.nodes, "Package", 3);

    const rootPackage = getNode(graph.nodes, "package:.");
    const apiPackage = getNode(graph.nodes, "package:apps/api");
    const corePackage = getNode(graph.nodes, "package:packages/core");

    assert.equal(rootPackage.properties.name, "workspace-monorepo");
    assert.equal(rootPackage.properties.workspaceRoot, true);
    assert.equal(apiPackage.properties.name, "@sample/api");
    assert.equal(corePackage.properties.name, "@sample/core");

    assertRelationship(graph.relationships, "repo:" + path.join(fixturesRoot, "workspace-monorepo"), "HAS_PACKAGE", "package:apps/api");
    assertRelationship(graph.relationships, "package:apps/api", "PACKAGE_CONTAINS_FILE", "file:apps/api/src/server.ts");
    assertRelationship(graph.relationships, "package:packages/core", "PACKAGE_CONTAINS_FILE", "file:packages/core/src/index.ts");
    assertRelationship(graph.relationships, "package:apps/api", "PACKAGE_DECLARES_CONFIG", "config:package:apps/api:package.json:name");
    assertRelationship(graph.relationships, "file:apps/api/src/server.ts:import:1:@sample/core", "RESOLVES_TO", "file:packages/core/src/index.ts");
    assertRelationship(graph.relationships, "file:apps/api/src/server.ts:import:1:@sample/core", "IMPORTS_PACKAGE", "package:packages/core");
    assert.ok(graph.relationships.some((relationship) => (
      relationship.from === "package:apps/api"
      && relationship.to === "package:packages/core"
      && relationship.type === "PACKAGE_IMPORTS_PACKAGE"
      && (
        relationship.properties.dependencyType === "dependencies"
        || relationship.properties.dependencyType === "internalImport"
      )
    )));
  });

  it("treats require() calls as Import nodes with isCjs:true and resolves them", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "commonjs-require"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 4);

    const cjsImports = graph.nodes.filter(
      (n) => n.label === "Import" && n.properties.isCjs === true,
    );
    assert.equal(cjsImports.length, 4, "Expected CJS Import nodes for default, member, destructured, and conditional require");

    const utilsImport = cjsImports.find((n) => n.properties.source === "./utils");
    const helperImport = cjsImports.find((n) => (
      n.properties.source === "./utils"
      && typeof n.properties.bindings === "string"
      && n.properties.bindings.includes("\"local\":\"helper\"")
    ));
    const libImport = cjsImports.find((n) => n.properties.source === "./lib");
    const conditionalImport = cjsImports.find((n) => n.properties.source === "./conditional");
    assert.ok(utilsImport, "CJS import of ./utils");
    assert.ok(helperImport, "CJS member import of ./utils.helper");
    assert.ok(libImport, "CJS import of ./lib");
    assert.ok(conditionalImport, "conditional CJS import of ./conditional");

    assert.equal(utilsImport!.properties.isDynamic, false);
    assert.equal(helperImport!.properties.isDynamic, false);
    assert.equal(libImport!.properties.isDynamic, false);
    assert.equal(conditionalImport!.properties.isDynamic, true);

    const utilsBindings = JSON.parse(utilsImport!.properties.bindings as string);
    assert.deepEqual(utilsBindings, [{ imported: "default", local: "utils", kind: "default" }]);

    const helperBindings = JSON.parse(helperImport!.properties.bindings as string);
    assert.deepEqual(helperBindings, [{ imported: "helper", local: "helper", kind: "named" }]);

    const libBindings = JSON.parse(libImport!.properties.bindings as string);
    assert.deepEqual(libBindings, [
      { imported: "foo",  local: "foo",   kind: "named" },
      { imported: "bar",  local: "bar",   kind: "named" },
      { imported: "baz",  local: "myBaz", kind: "named" },
    ]);

    assert.equal(graph.report.resolvedImports, 4);
    assertRelationship(graph.relationships, utilsImport!.id, "RESOLVES_TO", "file:utils.js");
    assertRelationship(graph.relationships, helperImport!.id, "RESOLVES_TO", "file:utils.js");
    assertRelationship(graph.relationships, libImport!.id, "RESOLVES_TO", "file:lib.js");
    assertRelationship(graph.relationships, conditionalImport!.id, "RESOLVES_TO", "file:conditional.js");

    const helperFunction = graph.nodes.find((n) => n.label === "Function" && n.id === "file:utils.js:function:1:helper")!;
    const helperCall = graph.nodes.find((n) => n.label === "Call" && n.properties.expression === "helper")!;
    assertRelationship(graph.relationships, helperCall.id, "CALL_RESOLVES_TO", helperFunction.id);

    // Variable-specifier require(utils.name) must NOT produce an Import node
    const variableRequire = graph.nodes.find(
      (n) => n.label === "Import" && n.properties.source === "utils.name",
    );
    assert.equal(variableRequire, undefined, "Variable-specifier require must not be captured");
  });

  it("captures new_expression constructor calls in function bodies and at module level", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "new-expression"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const initFn = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "initialize")!;
    assert.ok(initFn, "initialize function node");

    // new_expression inside function body → CALLS relationship
    const bodyCalls = graph.relationships
      .filter((r) => r.type === "CALLS" && r.from === initFn.id)
      .map((r) => graph.nodes.find((n) => n.id === r.to)!);

    const bodyExpressions = bodyCalls.map((n) => n.properties.expression as string).sort();
    // new EventEmitter(), new PrismaClient(), new express.Router(), emitter.on()
    assert.deepEqual(bodyExpressions, [
      "emitter.on",
      "new EventEmitter",
      "new PrismaClient",
      "new express.Router",
    ]);

    // callee = constructor name, receiver = null for simple constructors
    const emitterCall = bodyCalls.find((n) => n.properties.expression === "new EventEmitter")!;
    assert.equal(emitterCall.properties.callee, "EventEmitter");
    assert.equal(emitterCall.properties.receiver, null);

    // receiver extracted for namespaced constructors (new express.Router)
    const routerCall = bodyCalls.find((n) => n.properties.expression === "new express.Router")!;
    assert.equal(routerCall.properties.callee, "Router");
    assert.equal(routerCall.properties.receiver, "express");

    // new_expression at module level → MODULE_CALLS
    const moduleCalls = graph.relationships
      .filter((r) => r.type === "MODULE_CALLS")
      .map((r) => graph.nodes.find((n) => n.id === r.to)!);

    assert.equal(moduleCalls.length, 1);
    assert.equal(moduleCalls[0]!.properties.expression, "new Worker");
    assert.equal(moduleCalls[0]!.properties.callee, "Worker");
    assert.equal(moduleCalls[0]!.properties.receiver, null);
  });

  it("extracts inline route handler functions as Function nodes linked via PASSED_TO", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "inline-handlers"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    // 4 inline handlers: router.get, router.post, router.delete, router.use
    const inlineHandlers = graph.nodes.filter(
      (n) => n.label === "Function" && (n.properties.name as string).startsWith("<"),
    );
    assert.equal(inlineHandlers.length, 4, "Expected 4 inline handler Function nodes");

    // synthetic names encode the callee and route path
    const names = inlineHandlers.map((n) => n.properties.name as string).sort();
    assert.deepEqual(names, [
      "<router.delete:/users/:id:arg1>",
      "<router.get:/users:arg1>",
      "<router.post:/users:arg1>",
      "<router.use:/users:arg2>",
    ]);

    // each linked from file via DEFINES_FUNCTION
    for (const handler of inlineHandlers) {
      assert.ok(
        graph.relationships.some((r) => r.from === "file:routes.ts" && r.to === handler.id && r.type === "DEFINES_FUNCTION"),
        `DEFINES_FUNCTION missing for ${handler.properties.name}`,
      );
    }

    // each linked to its module-level Call node via PASSED_TO
    const passedTo = graph.relationships.filter((r) => r.type === "PASSED_TO");
    assert.equal(passedTo.length, 4, "Expected 4 PASSED_TO relationships");

    for (const rel of passedTo) {
      const callNode = graph.nodes.find((n) => n.id === rel.to);
      assert.ok(callNode, `Call node ${rel.to} missing`);
      assert.equal(callNode.label, "Call");
    }

    // isAsync is correctly extracted
    const getHandler = inlineHandlers.find((n) => (n.properties.name as string).includes("router.get"))!;
    const postHandler = inlineHandlers.find((n) => (n.properties.name as string).includes("router.post"))!;
    assert.equal(getHandler.properties.isAsync, true);
    assert.equal(postHandler.properties.isAsync, false);

    // parameters are extracted
    const getParams = JSON.parse(getHandler.properties.parameters as string);
    assert.deepEqual(getParams, [{ name: "req", type: null }, { name: "res", type: null }]);

    // inline handler body calls are captured via CALLS
    const getCallNodes = graph.relationships
      .filter((r) => r.type === "CALLS" && r.from === getHandler.id)
      .map((r) => graph.nodes.find((n) => n.id === r.to)!);
    assert.equal(getCallNodes.length, 1);
    assert.equal(getCallNodes[0]!.properties.callee, "json");

    // PASSED_TO target is the same Call node already emitted by MODULE_CALLS
    for (const rel of passedTo) {
      assert.ok(
        graph.relationships.some((r) => r.type === "MODULE_CALLS" && r.to === rel.to),
        `PASSED_TO target ${rel.to} must also have MODULE_CALLS`,
      );
    }
  });

  it("captures module-level call expressions as Call nodes linked via MODULE_CALLS", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "module-calls"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 2);

    const moduleCalls = graph.relationships.filter((r) => r.type === "MODULE_CALLS");
    // app.ts: app.use(cors()), app.use(express.json()), app.listen(3000)
    // server.ts: server.listen(8080), server.on(...), server.close()
    assert.equal(moduleCalls.length, 6, "Expected 6 MODULE_CALLS relationships");

    const callNodeIds = new Set(moduleCalls.map((r) => r.to));
    for (const id of callNodeIds) {
      assert.ok(graph.nodes.find((n) => n.id === id && n.label === "Call"), `Call node ${id} missing`);
    }

    // all MODULE_CALLS must originate from File nodes
    for (const rel of moduleCalls) {
      const src = graph.nodes.find((n) => n.id === rel.from);
      assert.ok(src, `Source node ${rel.from} missing`);
      assert.equal(src.label, "File");
    }

    // verify callee/receiver extraction for app.ts calls
    const appFileId = "file:app.ts";
    const appCalls = moduleCalls
      .filter((r) => r.from === appFileId)
      .map((r) => graph.nodes.find((n) => n.id === r.to)!);

    const expressions = appCalls.map((n) => n.properties.expression as string).sort();
    assert.deepEqual(expressions, ["app.listen", "app.use", "app.use"]);

    const listenCall = appCalls.find((n) => n.properties.callee === "listen");
    assert.ok(listenCall, "app.listen call node");
    assert.equal(listenCall.properties.receiver, "app");

    // verify top-level await is unwrapped (server.ts: await server.close())
    const serverFileId = "file:server.ts";
    const serverCalls = moduleCalls
      .filter((r) => r.from === serverFileId)
      .map((r) => graph.nodes.find((n) => n.id === r.to)!);

    const serverExpressions = serverCalls.map((n) => n.properties.expression as string).sort();
    assert.deepEqual(serverExpressions, ["server.close", "server.listen", "server.on"]);

    // module-level calls must NOT appear as function-body CALLS
    for (const id of callNodeIds) {
      assert.ok(
        !graph.relationships.some((r) => r.type === "CALLS" && r.to === id),
        `Call node ${id} must not be linked via CALLS`,
      );
    }

    // function-body call inside bootstrap() must still use CALLS, not MODULE_CALLS
    const bootstrapCalls = graph.relationships.filter((r) => {
      const fn = graph.nodes.find((n) => n.id === r.from);
      return r.type === "CALLS" && fn?.properties.name === "bootstrap";
    });
    assert.equal(bootstrapCalls.length, 1, "bootstrap() has one body call (app.listen)");
  });

  it("links module-level variable initializers to their Call nodes", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "variable-initializers"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const initializedBy = graph.relationships.filter((r) => r.type === "INITIALIZED_BY");
    assert.equal(initializedBy.length, 4, "Expected 4 module-level initializer call links");

    const callsByVariable = new Map<string, GraphNode>();
    for (const rel of initializedBy) {
      const variable = getNode(graph.nodes, rel.from);
      const call = getNode(graph.nodes, rel.to);
      assert.equal(variable.label, "Variable");
      assert.equal(call.label, "Call");
      callsByVariable.set(String(variable.properties.name), call);
    }

    assert.equal(callsByVariable.get("app")?.properties.expression, "express");
    assert.equal(callsByVariable.get("app")?.properties.callee, "express");
    assert.equal(callsByVariable.get("app")?.properties.receiver, null);

    assert.equal(callsByVariable.get("db")?.properties.expression, "new PrismaClient");
    assert.equal(callsByVariable.get("db")?.properties.callee, "PrismaClient");
    assert.equal(callsByVariable.get("db")?.properties.receiver, null);

    assert.equal(callsByVariable.get("router")?.properties.expression, "Router");
    assert.equal(callsByVariable.get("router")?.properties.callee, "Router");
    assert.equal(callsByVariable.get("router")?.properties.receiver, null);

    assert.equal(callsByVariable.get("worker")?.properties.expression, "new Worker");
    assert.equal(callsByVariable.get("worker")?.properties.callee, "Worker");
    assert.equal(callsByVariable.get("worker")?.properties.receiver, null);

    assert.ok(!callsByVariable.has("port"), "Literal initializer must not get INITIALIZED_BY");
    assert.ok(!callsByVariable.has("local"), "Function-scoped initializer must not get INITIALIZED_BY");
  });

  it("emits placeholder variables for anonymous export default expressions", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "export-default-expressions"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.parsedFiles, 4);

    const defaultVariables = graph.nodes.filter(
      (n) => n.label === "Variable" && n.properties.name === "default",
    );
    assert.equal(defaultVariables.length, 3, "Expected default placeholders for expression exports only");

    for (const variable of defaultVariables) {
      assert.equal(variable.properties.kind, "export_default");
      assert.equal(variable.properties.isExported, true);
      assert.ok(
        graph.relationships.some((r) => (
          r.type === "DEFINES_VARIABLE"
          && r.to === variable.id
          && r.from.startsWith("file:")
        )),
        `DEFINES_VARIABLE missing for ${variable.id}`,
      );
    }

    assertRelationship(
      graph.relationships,
      "file:identifier.ts",
      "DEFINES_VARIABLE",
      "file:identifier.ts:variable:3:default",
    );
    assertRelationship(
      graph.relationships,
      "file:call.ts",
      "DEFINES_VARIABLE",
      "file:call.ts:variable:3:default",
    );
    assertRelationship(
      graph.relationships,
      "file:anonymous-function.ts",
      "DEFINES_VARIABLE",
      "file:anonymous-function.ts:variable:1:default",
    );

    assert.equal(
      graph.nodes.find((n) => n.id === "file:named-function.ts:variable:1:default"),
      undefined,
      "Named default function declaration must not get a placeholder Variable",
    );

    const page = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "Page");
    assert.ok(page, "Named default function should still be parsed as a Function");
    assert.equal(page.properties.isExported, true);
  });

  it("extracts Express/Koa-style route method calls into Route nodes", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "express-koa-routes"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const routes = graph.nodes.filter((n) => n.label === "Route");
    assert.equal(routes.length, 8, "Expected 8 route declarations");

    const routesByKey = new Map(
      routes.map((route) => [`${route.properties.method}:${route.properties.path ?? "<none>"}`, route]),
    );

    assert.ok(routesByKey.has("GET:/users"));
    assert.ok(routesByKey.has("POST:/users"));
    assert.ok(routesByKey.has("PUT:/users/:id"));
    assert.ok(routesByKey.has("DELETE:/users/:id"));
    assert.ok(routesByKey.has("USE:/admin"));
    assert.ok(routesByKey.has("USE:<none>"));
    assert.ok(routesByKey.has("GET:/dashboard"));
    assert.ok(routesByKey.has("USE:/api"));
    assert.equal(routesByKey.get("GET:/users")?.properties.framework, "express-koa");
    assert.equal(routesByKey.get("GET:/users")?.properties.handlerName, "listUsers");
    assert.equal(routesByKey.get("GET:/users")?.properties.pathExpression, "USERS_PATH");
    assert.equal(routesByKey.get("GET:/users")?.properties.fullPath, "/api/users");
    assert.equal(routesByKey.get("POST:/users")?.properties.handlerName, "authenticate");
    assert.equal(routesByKey.get("POST:/users")?.properties.fullPath, "/api/users");
    assert.equal(routesByKey.get("PUT:/users/:id")?.properties.handlerName, "createUser");
    assert.equal(routesByKey.get("PUT:/users/:id")?.properties.fullPath, "/api/users/:id");
    assert.equal(routesByKey.get("DELETE:/users/:id")?.properties.handlerName, null);
    assert.equal(routesByKey.get("DELETE:/users/:id")?.properties.fullPath, "/api/users/:id");
    assert.equal(routesByKey.get("USE:/admin")?.properties.fullPath, "/api/admin");
    assert.equal(routesByKey.get("GET:/dashboard")?.properties.fullPath, "/api/admin/dashboard");
    assert.equal(routesByKey.get("USE:/api")?.properties.fullPath, "/api");

    for (const route of routes) {
      assertRelationship(graph.relationships, "file:routes.ts", "DECLARES_ROUTE", route.id);
    }

    const routeHandledBy = graph.relationships.filter((r) => r.type === "ROUTE_HANDLED_BY");
    assert.equal(routeHandledBy.length, 9, "Expected referenced and inline handlers to be linked");

    const handlerNamesByRoute = new Map<string, string[]>();
    for (const rel of routeHandledBy) {
      const route = getNode(graph.nodes, rel.from);
      const handler = getNode(graph.nodes, rel.to);
      const key = `${route.properties.method}:${route.properties.path ?? "<none>"}`;
      handlerNamesByRoute.set(key, [
        ...(handlerNamesByRoute.get(key) ?? []),
        String(handler.properties.name),
      ]);
    }

    assert.deepEqual(handlerNamesByRoute.get("GET:/users"), ["listUsers"]);
    assert.deepEqual(handlerNamesByRoute.get("POST:/users")?.sort(), ["authenticate", "createUser", "validateUser"]);
    assert.deepEqual(handlerNamesByRoute.get("PUT:/users/:id"), ["createUser"]);
    assert.deepEqual(handlerNamesByRoute.get("USE:/admin"), ["authenticate"]);
    assert.deepEqual(handlerNamesByRoute.get("USE:<none>"), ["authenticate"]);
    assert.deepEqual(handlerNamesByRoute.get("DELETE:/users/:id"), ["<router.delete:/users/:id:arg1>"]);
    assert.deepEqual(handlerNamesByRoute.get("GET:/dashboard"), ["<adminRouter.get:/dashboard:arg1>"]);

    const falsePositive = routes.find((route) => route.properties.path === "not-a-route");
    assert.equal(falsePositive, undefined, "cache.get(...) must not be treated as a route");

    const lifecycleSteps = graph.relationships.filter((r) => r.type === "ROUTE_LIFECYCLE_STEP");
    const lifecycleByRoute = new Map<string, Array<{ name: string; role: unknown; scope: unknown; hook: unknown; orderIndex: unknown }>>();
    for (const rel of lifecycleSteps) {
      const route = getNode(graph.nodes, rel.from);
      const fn = getNode(graph.nodes, rel.to);
      const key = `${route.properties.method}:${route.properties.path ?? "<none>"}`;
      lifecycleByRoute.set(key, [
        ...(lifecycleByRoute.get(key) ?? []),
        {
          name: String(fn.properties.name),
          role: rel.properties.role,
          scope: rel.properties.scope,
          hook: rel.properties.hook,
          orderIndex: rel.properties.orderIndex,
        },
      ]);
    }

    assert.deepEqual(lifecycleByRoute.get("POST:/users"), [
      { name: "authenticate", role: "middleware", scope: "route", hook: null, orderIndex: 0 },
      { name: "validateUser", role: "middleware", scope: "route", hook: null, orderIndex: 1 },
      { name: "createUser", role: "handler", scope: "route", hook: "handler", orderIndex: 2 },
    ]);
    assert.deepEqual(lifecycleByRoute.get("PUT:/users/:id"), [
      { name: "authenticate", role: "middleware", scope: "route", hook: null, orderIndex: 0 },
      { name: "validateUser", role: "middleware", scope: "route", hook: null, orderIndex: 1 },
      { name: "createUser", role: "handler", scope: "route", hook: "handler", orderIndex: 2 },
    ]);
    assert.deepEqual(lifecycleByRoute.get("USE:<none>"), [
      { name: "authenticate", role: "middleware", scope: "router", hook: null, orderIndex: 0 },
    ]);

    const precedes = graph.relationships
      .filter((r) => r.type === "LIFECYCLE_PRECEDES")
      .map((rel) => ({
        from: getNode(graph.nodes, rel.from).properties.name,
        to: getNode(graph.nodes, rel.to).properties.name,
        routeId: rel.properties.routeId,
        orderIndex: rel.properties.orderIndex,
      }));
    assert.ok(precedes.some((rel) => (
      rel.from === "authenticate"
      && rel.to === "validateUser"
      && rel.routeId === routesByKey.get("POST:/users")?.id
      && rel.orderIndex === 0
    )));
    assert.ok(precedes.some((rel) => (
      rel.from === "validateUser"
      && rel.to === "createUser"
      && rel.routeId === routesByKey.get("PUT:/users/:id")?.id
      && rel.orderIndex === 1
    )));

    const mounts = graph.relationships.filter((r) => r.type === "MOUNTS");
    assert.equal(mounts.length, 4, "Expected router and middleware mount relationships");

    const mountTargets = mounts.map((rel) => {
      const source = getNode(graph.nodes, rel.from);
      const target = getNode(graph.nodes, rel.to);
      return {
        from: source.properties.name,
        to: target.properties.name,
        path: rel.properties.path,
        line: rel.properties.line,
      };
    });

    assert.ok(mountTargets.some((mount) => (
      mount.from === "app"
      && mount.to === "router"
      && mount.path === "/api"
    )));
    assert.ok(mountTargets.some((mount) => (
      mount.from === "router"
      && mount.to === "adminRouter"
      && mount.path === "/admin"
    )));
    assert.ok(mountTargets.some((mount) => (
      mount.from === "router"
      && mount.to === "authenticate"
      && mount.path === "/admin"
    )));
    assert.ok(mountTargets.some((mount) => (
      mount.from === "router"
      && mount.to === "authenticate"
      && mount.path === null
    )));
  });

  it("extracts Fastify route declarations and plugin registrations", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "fastify-routes"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const routes = graph.nodes.filter((n) => n.label === "Route");
    assert.equal(routes.length, 7, "Expected 7 Fastify route declarations");

    const routesByKey = new Map(
      routes.map((route) => [`${route.properties.method}:${route.properties.path}`, route]),
    );

    assert.ok(routesByKey.has("GET:/users"));
    assert.ok(routesByKey.has("POST:/users"));
    assert.ok(routesByKey.has("GET:/inline"));
    assert.ok(routesByKey.has("GET:/health"));
    assert.ok(routesByKey.has("GET:/status"));
    assert.ok(routesByKey.has("HEAD:/status"));
    assert.ok(routesByKey.has("GET:/object-inline"));

    for (const route of routes) {
      assert.equal(route.properties.framework, "fastify");
      assertRelationship(graph.relationships, "file:server.ts", "DECLARES_ROUTE", route.id);
    }

    assert.equal(routesByKey.get("GET:/users")?.properties.handlerName, "listUsers");
    assert.equal(routesByKey.get("POST:/users")?.properties.handlerName, "createUser");
    assert.equal(routesByKey.get("GET:/inline")?.properties.handlerName, null);
    assert.equal(routesByKey.get("GET:/health")?.properties.handlerName, "health");
    assert.equal(routesByKey.get("GET:/status")?.properties.handlerName, "health");
    assert.equal(routesByKey.get("HEAD:/status")?.properties.handlerName, "health");
    assert.equal(routesByKey.get("GET:/object-inline")?.properties.handlerName, "<fastify.route:/object-inline:handler>");

    const handlerNamesByRoute = new Map<string, string[]>();
    for (const rel of graph.relationships.filter((r) => r.type === "ROUTE_HANDLED_BY")) {
      const route = getNode(graph.nodes, rel.from);
      const handler = getNode(graph.nodes, rel.to);
      const key = `${route.properties.method}:${route.properties.path}`;
      handlerNamesByRoute.set(key, [
        ...(handlerNamesByRoute.get(key) ?? []),
        String(handler.properties.name),
      ]);
    }

    assert.deepEqual(handlerNamesByRoute.get("GET:/users"), ["listUsers"]);
    assert.deepEqual(handlerNamesByRoute.get("POST:/users"), ["createUser"]);
    assert.deepEqual(handlerNamesByRoute.get("GET:/inline"), ["<fastify.get:/inline:arg1>"]);
    assert.deepEqual(handlerNamesByRoute.get("GET:/health"), ["health"]);
    assert.deepEqual(handlerNamesByRoute.get("GET:/status"), ["health"]);
    assert.deepEqual(handlerNamesByRoute.get("HEAD:/status"), ["health"]);
    assert.deepEqual(handlerNamesByRoute.get("GET:/object-inline")?.sort(), [
      "<fastify.route:/object-inline:handler>",
      "<fastify.route:/object-inline:preHandler>",
    ]);

    const lifecycleByRoute = new Map<string, Array<{ name: string; role: unknown; hook: unknown; orderIndex: unknown }>>();
    for (const rel of graph.relationships.filter((r) => r.type === "ROUTE_LIFECYCLE_STEP")) {
      const route = getNode(graph.nodes, rel.from);
      const fn = getNode(graph.nodes, rel.to);
      const key = `${route.properties.method}:${route.properties.path}`;
      lifecycleByRoute.set(key, [
        ...(lifecycleByRoute.get(key) ?? []),
        {
          name: String(fn.properties.name),
          role: rel.properties.role,
          hook: rel.properties.hook,
          orderIndex: rel.properties.orderIndex,
        },
      ]);
    }

    assert.deepEqual(lifecycleByRoute.get("POST:/users"), [
      { name: "auth", role: "middleware", hook: "preHandler", orderIndex: 0 },
      { name: "createUser", role: "handler", hook: "handler", orderIndex: 1 },
    ]);
    assert.deepEqual(lifecycleByRoute.get("GET:/object-inline"), [
      { name: "<fastify.route:/object-inline:preHandler>", role: "middleware", hook: "preHandler", orderIndex: 0 },
      { name: "<fastify.route:/object-inline:handler>", role: "handler", hook: "handler", orderIndex: 1 },
    ]);

    assert.ok(graph.relationships.some((rel) => (
      rel.type === "LIFECYCLE_PRECEDES"
      && getNode(graph.nodes, rel.from).properties.name === "auth"
      && getNode(graph.nodes, rel.to).properties.name === "createUser"
      && rel.properties.routeId === routesByKey.get("POST:/users")?.id
    )));

    const objectLiteralHandlers = graph.nodes.filter(
      (n) => n.label === "Function"
        && typeof n.properties.name === "string"
        && n.properties.name.includes("fastify.route:/object-inline"),
    );
    assert.equal(objectLiteralHandlers.length, 2, "Expected handler and preHandler synthetic functions");
    assert.ok(objectLiteralHandlers.some((handler) => handler.properties.name === "<fastify.route:/object-inline:handler>"));
    assert.ok(objectLiteralHandlers.some((handler) => handler.properties.name === "<fastify.route:/object-inline:preHandler>"));

    for (const handler of objectLiteralHandlers) {
      assert.ok(
        graph.relationships.some((r) => r.type === "PASSED_TO" && r.from === handler.id),
        `${handler.properties.name} must be linked to the owning call`,
      );
    }

    const mounts = graph.relationships.filter((r) => r.type === "MOUNTS");
    assert.equal(mounts.length, 1, "Expected Fastify plugin registration mount");
    const mount = mounts[0]!;
    assert.equal(getNode(graph.nodes, mount.from).properties.name, "fastify");
    assert.equal(getNode(graph.nodes, mount.to).properties.name, "usersPlugin");
    assert.equal(mount.properties.path, "/api");
  });

  it("resolves TS path aliases inherited via tsconfig extends chain", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "ts-paths-extends"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.equal(graph.report.resolvedImports, 1);
    assert.equal(graph.report.unresolvedRelativeImports, 0);

    assertRelationship(
      graph.relationships,
      "file:src/index.ts:import:1:@lib/helper",
      "RESOLVES_TO",
      "file:src/lib/helper.ts",
    );
  });

  it("marks import type statements with isTypeOnly:true", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "import-type"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const imports = graph.nodes.filter((n) => n.label === "Import");

    const userImport = imports.find((n) => n.properties.source === "./types");
    assert.ok(userImport, "import from ./types");
    assert.equal(userImport.properties.isTypeOnly, true);

    const expressImport = imports.find((n) => n.properties.source === "express");
    assert.ok(expressImport, "import from express");
    assert.equal(expressImport.properties.isTypeOnly, true);

    const httpImport = imports.find((n) => n.properties.source === "http");
    assert.ok(httpImport, "import from http");
    assert.equal(httpImport.properties.isTypeOnly, false);

    const fsImport = imports.find((n) => n.properties.source === "fs/promises");
    assert.ok(fsImport, "import from fs/promises");
    assert.equal(fsImport.properties.isTypeOnly, false);

    const reExportImport = imports.find((n) => n.properties.isReExport === true);
    assert.ok(reExportImport, "export type { User } re-export");
    assert.equal(reExportImport.properties.isTypeOnly, true);
  });

  it("extracts decorator arguments into a JSON-serialized args property", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "nestjs-decorators"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const decorators = graph.nodes.filter((n) => n.label === "Decorator");

    const controller = decorators.find((d) => d.properties.name === "Controller");
    assert.ok(controller, "Controller decorator");
    assert.deepEqual(JSON.parse(controller.properties.args as string), ["users"]);

    const getById = decorators.find(
      (d) => d.properties.name === "Get" && (d.properties.args as string).includes(":id"),
    );
    assert.ok(getById, "Get(':id') decorator");
    assert.deepEqual(JSON.parse(getById.properties.args as string), [":id"]);

    const getAll = decorators.find(
      (d) => d.properties.name === "Get" && d.properties.args === "[]",
    );
    assert.ok(getAll, "Get() decorator with no args");

    const deleteById = decorators.find(
      (d) => d.properties.name === "Delete" && (d.properties.args as string).includes(":id"),
    );
    assert.ok(deleteById, "Delete(':id') decorator");
    assert.deepEqual(JSON.parse(deleteById.properties.args as string), [":id"]);

    const useGuards = decorators.find((d) => d.properties.name === "UseGuards");
    assert.ok(useGuards, "UseGuards decorator");
    assert.deepEqual(JSON.parse(useGuards.properties.args as string), ["AuthGuard"]);

    const routes = graph.nodes.filter((n) => n.label === "Route");
    assert.equal(routes.length, 4, "Expected 4 NestJS controller routes");

    const routesByKey = new Map(
      routes.map((route) => [`${route.properties.method}:${route.properties.path}`, route]),
    );

    assert.ok(routesByKey.has("GET:/users"));
    assert.ok(routesByKey.has("GET:/users/:id"));
    assert.ok(routesByKey.has("POST:/users"));
    assert.ok(routesByKey.has("DELETE:/users/:id"));

    for (const route of routes) {
      assert.equal(route.properties.framework, "nestjs");
      assertRelationship(graph.relationships, "file:users.controller.ts", "DECLARES_ROUTE", route.id);
    }

    assert.equal(routesByKey.get("GET:/users")?.properties.handlerName, "findAll");
    assert.equal(routesByKey.get("GET:/users/:id")?.properties.handlerName, "findOne");
    assert.equal(routesByKey.get("POST:/users")?.properties.handlerName, "create");
    assert.equal(routesByKey.get("DELETE:/users/:id")?.properties.handlerName, "remove");

    const handlerNamesByRoute = new Map<string, string>();
    for (const rel of graph.relationships.filter((r) => r.type === "ROUTE_HANDLED_BY")) {
      const route = getNode(graph.nodes, rel.from);
      const handler = getNode(graph.nodes, rel.to);
      if (route.properties.framework !== "nestjs") continue;
      handlerNamesByRoute.set(
        `${route.properties.method}:${route.properties.path}`,
        String(handler.properties.name),
      );
    }

    assert.equal(handlerNamesByRoute.get("GET:/users"), "findAll");
    assert.equal(handlerNamesByRoute.get("GET:/users/:id"), "findOne");
    assert.equal(handlerNamesByRoute.get("POST:/users"), "create");
    assert.equal(handlerNamesByRoute.get("DELETE:/users/:id"), "remove");
  });

  it("extracts NestJS module metadata into class relationships", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "nestjs-modules"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const classId = (name: string): string => {
      const node = graph.nodes.find((n) => n.label === "Class" && n.properties.name === name);
      assert.ok(node, `Expected class ${name}`);
      return node.id;
    };

    const appModule = classId("AppModule");
    const usersModule = classId("UsersModule");
    const appController = classId("AppController");
    const appService = classId("AppService");
    const authService = classId("AuthService");
    const usersController = classId("UsersController");
    const usersService = classId("UsersService");

    assertRelationship(graph.relationships, appModule, "MODULE_IMPORTS", usersModule);
    assertRelationship(graph.relationships, appModule, "MODULE_CONTROLS", appController);
    assertRelationship(graph.relationships, appModule, "MODULE_PROVIDES", appService);
    assertRelationship(graph.relationships, appModule, "MODULE_PROVIDES", authService);
    assertRelationship(graph.relationships, appModule, "MODULE_EXPORTS", appService);
    assertRelationship(graph.relationships, appModule, "MODULE_EXPORTS", authService);

    assertRelationship(graph.relationships, usersModule, "MODULE_CONTROLS", usersController);
    assertRelationship(graph.relationships, usersModule, "MODULE_PROVIDES", usersService);
    assertRelationship(graph.relationships, usersModule, "MODULE_EXPORTS", usersService);
  });

  it("resolves constructor-injected service calls to class methods", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "nestjs-injection"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const controller = graph.nodes.find((n) => n.label === "Class" && n.properties.name === "UsersController");
    const service = graph.nodes.find((n) => n.label === "Class" && n.properties.name === "UsersService");
    assert.ok(controller, "UsersController class");
    assert.ok(service, "UsersService class");

    assert.ok(
      graph.relationships.some((r) => (
        r.from === controller.id
        && r.to === service.id
        && r.type === "INJECTS"
        && r.properties.fieldName === "usersService"
      )),
      "UsersController must inject UsersService through usersService",
    );

    const serviceFindAll = graph.nodes.find(
      (n) => n.label === "Function" && n.properties.className === "UsersService" && n.properties.name === "findAll",
    );
    const serviceFindOne = graph.nodes.find(
      (n) => n.label === "Function" && n.properties.className === "UsersService" && n.properties.name === "findOne",
    );
    assert.ok(serviceFindAll, "UsersService.findAll method");
    assert.ok(serviceFindOne, "UsersService.findOne method");

    const findAllCall = graph.nodes.find(
      (n) => n.label === "Call" && n.properties.expression === "this.usersService.findAll",
    );
    const findOneCall = graph.nodes.find(
      (n) => n.label === "Call" && n.properties.expression === "this.usersService.findOne",
    );
    assert.ok(findAllCall, "this.usersService.findAll call");
    assert.ok(findOneCall, "this.usersService.findOne call");

    assertRelationship(graph.relationships, findAllCall.id, "CALL_RESOLVES_TO", serviceFindAll.id);
    assertRelationship(graph.relationships, findOneCall.id, "CALL_RESOLVES_TO", serviceFindOne.id);
  });

  it("resolves method calls through variables initialized with new", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "instance-method-resolution"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const appRun = graph.nodes.find(
      (n) => n.label === "Function" && n.properties.className === "AppService" && n.properties.name === "run",
    );
    const importedExecute = graph.nodes.find(
      (n) => n.label === "Function" && n.properties.className === "ImportedService" && n.properties.name === "execute",
    );
    assert.ok(appRun, "AppService.run method");
    assert.ok(importedExecute, "ImportedService.execute method");

    const appRunCall = graph.nodes.find(
      (n) => n.label === "Call" && n.properties.expression === "appService.run",
    );
    const importedExecuteCall = graph.nodes.find(
      (n) => n.label === "Call" && n.properties.expression === "importedService.execute",
    );
    assert.ok(appRunCall, "appService.run call");
    assert.ok(importedExecuteCall, "importedService.execute call");

    assertRelationship(graph.relationships, appRunCall.id, "CALL_RESOLVES_TO", appRun.id);
    assertRelationship(graph.relationships, importedExecuteCall.id, "CALL_RESOLVES_TO", importedExecute.id);
  });

  it("captures module.exports assignments as exported metadata", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "commonjs-exports"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    assert.equal(graph.nodes.find((n) => n.label === "Function" && n.properties.name === "createClient")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.label === "Class" && n.properties.name === "ClientFactory")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "defaultTimeout")?.properties.isExported, true);
    assert.equal(graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "internalOnly")?.properties.isExported, false);

    const name = graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "name")!;
    const make = graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "make")!;
    const extra = graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "extra")!;
    const direct = graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "direct")!;
    const assignedName = graph.nodes.find((n) => n.label === "Variable" && n.properties.name === "assignedName")!;

    assert.ok(name);
    assert.ok(make);
    assert.ok(extra);
    assert.ok(direct);
    assert.ok(assignedName);
    assert.equal(name.properties.isExported, true);
    assert.equal(make.properties.isExported, true);
    assert.equal(extra.properties.isExported, true);
    assert.equal(direct.properties.isExported, true);
    assert.equal(assignedName.properties.isExported, true);
    assertRelationship(graph.relationships, "file:index.js", "DEFINES_VARIABLE", name.id);
    assertRelationship(graph.relationships, "file:index.js", "DEFINES_VARIABLE", make.id);
    assertRelationship(graph.relationships, "file:index.js", "DEFINES_VARIABLE", extra.id);
    assertRelationship(graph.relationships, "file:index.js", "DEFINES_VARIABLE", direct.id);
    assertRelationship(graph.relationships, "file:index.js", "DEFINES_VARIABLE", assignedName.id);
  });

  it("models backend config and environment usage", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "config-env"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const envVars = graph.nodes.filter((n) => n.label === "EnvVar");
    assert.ok(envVars.some((n) => n.properties.name === "API_TOKEN"));
    assert.ok(envVars.some((n) => n.properties.name === "DATABASE_URL"));
    assert.ok(envVars.some((n) => n.properties.name === "NODE_ENV"));

    const databaseUrl = envVars.find((n) => n.properties.name === "DATABASE_URL")!;
    const nodeEnv = envVars.find((n) => n.properties.name === "NODE_ENV")!;
    const apiToken = envVars.find((n) => n.properties.name === "API_TOKEN")!;
    const listUsers = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "listUsers")!;
    const route = graph.nodes.find((n) => n.label === "Route" && n.properties.path === "/users")!;

    assertRelationship(graph.relationships, "file:server.ts", "USES_ENV", apiToken.id);
    assertRelationship(graph.relationships, listUsers.id, "USES_ENV", databaseUrl.id);
    assertRelationship(graph.relationships, listUsers.id, "USES_ENV", nodeEnv.id);
    assertRelationship(graph.relationships, route.id, "USES_ENV", databaseUrl.id);
    assertRelationship(graph.relationships, route.id, "USES_ENV", nodeEnv.id);

    const featureFlag = graph.nodes.find((n) => n.label === "ConfigValue" && n.properties.name === "FEATURE_FLAG")!;
    const retryLimit = graph.nodes.find((n) => n.label === "ConfigValue" && n.properties.name === "RETRY_LIMIT")!;
    const enableCache = graph.nodes.find((n) => n.label === "ConfigValue" && n.properties.name === "ENABLE_CACHE")!;
    const internalOnly = graph.nodes.find((n) => n.label === "ConfigValue" && n.properties.name === "INTERNAL_ONLY");

    assert.equal(featureFlag.properties.value, "FEATURE_USERS");
    assert.equal(featureFlag.properties.valueType, "string");
    assert.equal(retryLimit.properties.value, "3");
    assert.equal(retryLimit.properties.valueType, "number");
    assert.equal(enableCache.properties.value, "true");
    assert.equal(enableCache.properties.valueType, "boolean");
    assert.equal(internalOnly, undefined);
    assertRelationship(graph.relationships, "file:config.ts", "DECLARES_CONFIG", featureFlag.id);
    assertRelationship(graph.relationships, "file:server.ts", "CONSUMES_CONFIG", featureFlag.id);
    assertRelationship(graph.relationships, "file:server.ts", "CONSUMES_CONFIG", retryLimit.id);

    const packageName = graph.nodes.find(
      (n) => n.label === "ConfigValue" && n.properties.name === "package.json:name",
    )!;
    const tsTarget = graph.nodes.find(
      (n) => n.label === "ConfigValue" && n.properties.name === "tsconfig.json:compilerOptions.target",
    )!;
    assert.equal(packageName.properties.value, "config-env-fixture");
    assert.equal(tsTarget.properties.value, "ES2022");
  });

  it("adds non-HTTP backend entrypoint semantics", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "backend-entrypoints"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const entrypoints = graph.nodes.filter((n) => n.label === "EntryPoint");
    assert.equal(entrypoints.length, 5, "Expected event, queue, cron, realtime, and NestJS scheduler entrypoints");

    const entrypointsByKey = new Map(
      entrypoints.map((entrypoint) => [
        `${entrypoint.properties.kind}:${entrypoint.properties.trigger ?? "<none>"}`,
        entrypoint,
      ]),
    );

    assert.equal(entrypointsByKey.get("event:data")?.properties.library, "event-emitter");
    assert.equal(entrypointsByKey.get("queue:email")?.properties.library, "bull");
    assert.equal(entrypointsByKey.get("cron:*/5 * * * *")?.properties.library, "node-cron");
    assert.equal(entrypointsByKey.get("realtime:connection")?.properties.library, "socket.io");
    assert.equal(entrypointsByKey.get("scheduler:0 * * * *")?.properties.library, "nestjs-schedule");

    for (const entrypoint of entrypoints) {
      assertRelationship(graph.relationships, "file:service.ts", "DECLARES_ENTRYPOINT", entrypoint.id);
    }

    const handledBy = new Map<string, string[]>();
    for (const rel of graph.relationships.filter((r) => r.type === "ENTRYPOINT_HANDLED_BY")) {
      const entrypoint = getNode(graph.nodes, rel.from);
      const handler = getNode(graph.nodes, rel.to);
      const key = `${entrypoint.properties.kind}:${entrypoint.properties.trigger ?? "<none>"}`;
      handledBy.set(key, [...(handledBy.get(key) ?? []), String(handler.properties.name)]);
    }

    assert.deepEqual(handledBy.get("event:data"), ["handleData"]);
    assert.deepEqual(handledBy.get("queue:email"), ["handleJob"]);
    assert.deepEqual(handledBy.get("cron:*/5 * * * *"), ["<cron.schedule:*/5 * * * *:arg1>"]);
    assert.deepEqual(handledBy.get("realtime:connection"), ["handleConnection"]);
    assert.deepEqual(handledBy.get("scheduler:0 * * * *"), ["syncUsers"]);
  });

  it("links backend handlers to data-access models and operations", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "data-access"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);

    const dataModels = graph.nodes.filter((n) => n.label === "DataModel");
    assert.ok(dataModels.some((n) => n.properties.name === "user" && n.properties.library === "prisma"));
    assert.ok(dataModels.some((n) => n.properties.name === "users" && n.properties.library === "typeorm"));
    assert.ok(dataModels.some((n) => n.properties.name === "User" && n.properties.library === "typeorm"));
    assert.ok(dataModels.some((n) => n.properties.name === "Audit" && n.properties.library === "mongoose"));
    assert.ok(dataModels.some((n) => n.properties.name === "Job" && n.properties.library === "sequelize"));
    assert.ok(dataModels.some((n) => n.properties.name === "users" && n.properties.library === "knex"));
    assert.ok(!dataModels.some((n) => n.properties.name === "Object"));
    assert.ok(!dataModels.some((n) => n.properties.name === "NestFactory"));

    const userModel = dataModels.find((n) => n.properties.name === "user" && n.properties.library === "prisma")!;
    const usersModel = dataModels.find((n) => n.properties.name === "users" && n.properties.library === "typeorm")!;
    const userTypeOrmModel = dataModels.find((n) => n.properties.name === "User" && n.properties.library === "typeorm")!;
    const auditModel = dataModels.find((n) => n.properties.name === "Audit" && n.properties.library === "mongoose")!;
    const jobModel = dataModels.find((n) => n.properties.name === "Job" && n.properties.library === "sequelize")!;
    const knexUsersModel = dataModels.find((n) => n.properties.name === "users" && n.properties.library === "knex")!;
    const listUsers = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "listUsers")!;
    const createUser = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "createUser")!;
    const handleJob = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "handleJob")!;
    const findUsers = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "findUsers")!;
    const createUserMethod = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "createUser" && n.properties.className === "TypeOrmBackedRepository")!;
    const readAudit = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "readAudit")!;
    const knexListUsers = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "listUsers" && n.properties.className === "KnexBackedRepository")!;
    const listViaRepository = graph.nodes.find((n) => n.label === "Function" && n.properties.name === "listViaRepository")!;
    const getUsersRoute = graph.nodes.find((n) => n.label === "Route" && n.properties.method === "GET")!;
    const postUsersRoute = graph.nodes.find((n) => n.label === "Route" && n.properties.method === "POST")!;
    const cleanupEntrypoint = graph.nodes.find((n) => n.label === "EntryPoint" && n.properties.trigger === "cleanup")!;

    assertDataAccess(graph.relationships, listUsers.id, userModel.id, "read", "prisma");
    assertDataAccess(graph.relationships, listUsers.id, auditModel.id, "read", "mongoose");
    assertDataAccess(graph.relationships, createUser.id, usersModel.id, "create", "typeorm");
    assertDataAccess(graph.relationships, createUser.id, userModel.id, "update", "prisma");
    assertDataAccess(graph.relationships, handleJob.id, jobModel.id, "delete", "sequelize");
    assertDataAccess(graph.relationships, findUsers.id, userModel.id, "read", "prisma");
    assertDataAccess(graph.relationships, createUserMethod.id, userTypeOrmModel.id, "create", "typeorm");
    assertDataAccess(graph.relationships, readAudit.id, auditModel.id, "read", "mongoose");
    assertDataAccess(graph.relationships, knexListUsers.id, knexUsersModel.id, "read", "knex");
    assertDataAccess(graph.relationships, listViaRepository.id, userModel.id, "read", "prisma");

    assertDataAccess(graph.relationships, getUsersRoute.id, userModel.id, "read", "prisma");
    assertDataAccess(graph.relationships, postUsersRoute.id, usersModel.id, "create", "typeorm");
    assertDataAccess(graph.relationships, cleanupEntrypoint.id, jobModel.id, "delete", "sequelize");
  });

  it("classifies production, test, fixture, support, and generated files", async () => {
    const graph = await buildCodeGraph(path.join(fixturesRoot, "file-classification"), {
      continueOnError: false,
    });

    assert.equal(graph.report.failedFiles.length, 0);
    assert.deepEqual(graph.report.fileClassifications, {
      production: 1,
      test: 2,
      fixture: 1,
      support: 2,
      generated: 1,
    });

    assertFileClassification(graph.nodes, "src/index.ts", "production", false, false, false, false);
    assertFileClassification(graph.nodes, "src/user.test.ts", "test", true, false, false, false);
    assertFileClassification(graph.nodes, "src/__tests__/api.ts", "test", true, false, false, false);
    assertFileClassification(graph.nodes, "fixtures/user.ts", "fixture", false, true, false, false);
    assertFileClassification(graph.nodes, "__mocks__/client.ts", "support", false, false, true, false);
    assertFileClassification(graph.nodes, "setupTests.ts", "support", false, false, true, false);
    assertFileClassification(graph.nodes, "src/generated/client.ts", "generated", false, false, false, true);
  });
});

async function createScanErrorFixture(): Promise<string> {
  const fixturePath = await mkdtemp(path.join(os.tmpdir(), "concentrate-scan-errors-"));
  await writeFile(
    path.join(fixturePath, "good.ts"),
    "export function good(): string {\n  return \"ok\";\n}\n",
    "utf8",
  );
  await writeFile(path.join(fixturePath, "bad.ts"), "export function bad( {\n", "utf8");
  return fixturePath;
}

function assertNodeCount(nodes: GraphNode[], label: GraphNodeLabel, expected: number): void {
  assert.equal(nodes.filter((node) => node.label === label).length, expected);
}

function assertRelationship(
  relationships: GraphRelationship[],
  from: string,
  type: GraphRelationshipType,
  to: string,
): void {
  assert.ok(
    relationships.some((relationship) => (
      relationship.from === from
      && relationship.type === type
      && relationship.to === to
    )),
    `Expected relationship ${from} -[:${type}]-> ${to}`,
  );
}

function assertDataAccess(
  relationships: GraphRelationship[],
  from: string,
  to: string,
  operation: string,
  library: string,
): void {
  assert.ok(
    relationships.some((relationship) => (
      relationship.from === from
      && relationship.type === "ACCESSES_DATA"
      && relationship.to === to
      && relationship.properties.operation === operation
      && relationship.properties.library === library
    )),
    `Expected data access ${from} -[:ACCESSES_DATA {${operation}, ${library}}]-> ${to}`,
  );
}

function assertFileClassification(
  nodes: GraphNode[],
  relativePath: string,
  sourceType: string,
  isTest: boolean,
  isFixture: boolean,
  isSupport: boolean,
  isGenerated: boolean,
): void {
  const file = nodes.find((node) => node.label === "File" && node.properties.relativePath === relativePath);
  assert.ok(file, `Expected File node for ${relativePath}`);
  assert.equal(file.properties.sourceType, sourceType);
  assert.equal(file.properties.isTest, isTest);
  assert.equal(file.properties.isFixture, isFixture);
  assert.equal(file.properties.isSupport, isSupport);
  assert.equal(file.properties.isGenerated, isGenerated);
}

function getNode(nodes: GraphNode[], id: string): GraphNode {
  const node = nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `Expected node ${id}`);
  return node;
}

function callsForFunction(
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  functionName: string,
): string[] {
  const calls: string[] = [];

  for (const relationship of relationships.filter((item) => item.type === "CALLS")) {
    const functionNode = getNode(nodes, relationship.from);
    if (functionNode.properties.name !== functionName) {
      continue;
    }

    const callNode = getNode(nodes, relationship.to);
    calls.push(String(callNode.properties.expression));
  }

  return calls.sort();
}
