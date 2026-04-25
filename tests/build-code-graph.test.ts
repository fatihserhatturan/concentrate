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
      4,
    );
    assertRelationship(
      graph.relationships,
      "file:main.py:import:1:./utils",
      "RESOLVES_TO",
      "file:utils.py",
    );

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

    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "NewService"), ["strings.TrimSpace"]);
    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "Run"), ["fmt.Println"]);
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
      5,
    );

    assertRelationship(
      graph.relationships,
      "file:lib.rs",
      "DEFINES_CLASS",
      "file:lib.rs:class:4:Service",
    );

    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "new"), ["format"]);
    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "run"), ["println", "self.helper"]);
    assert.deepEqual(callsForFunction(graph.nodes, graph.relationships, "make"), ["Service::new", "String::new"]);
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
