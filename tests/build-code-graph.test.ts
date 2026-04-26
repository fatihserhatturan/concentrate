import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/scanner/build-code-graph.js";
import { getLanguageParser } from "../src/parsers/index.js";
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
    assert.equal(graph.nodes.find((n) => n.properties.name === "UserService" && n.label === "Class")?.properties.isExported, true);
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
