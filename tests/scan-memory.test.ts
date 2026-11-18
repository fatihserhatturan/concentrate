import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectGarbageAfterGrowth } from "../src/composition/garbage.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { ParsedSourceFile } from "../src/core/graph/model.js";
import { addParseResultsToGraph, OrderedParseResults } from "../src/core/scan/parse-results.js";
import type { ParseResult } from "../src/core/scan/parse-source.js";
import { createScanReport } from "../src/core/scan/report.js";
import { syntaxErrorLines, syntaxErrorLinesHere } from "../src/integrations/languages/syntax/syntax-errors.js";

const rootPath = "/repo";
const repoNodeId = `repo:${rootPath}`;

function parsedFile(name: string): ParseResult {
  const fileNodeId = `file:src/${name}`;
  const parsed: ParsedSourceFile = {
    fileNodeId,
    nodes: [
      { id: fileNodeId, label: "File", properties: { path: `${rootPath}/src/${name}`, relativePath: `src/${name}`, language: "typescript" } },
      { id: `${fileNodeId}#run`, label: "Function", properties: { name: "run" } },
    ],
    relationships: [{ from: fileNodeId, to: `${fileNodeId}#run`, type: "DEFINES_FUNCTION", properties: {} }],
    warnings: [`warning of ${name}`],
  };
  return { ok: true, parsed, filePath: `${rootPath}/src/${name}` };
}

function failedFile(name: string): ParseResult {
  return { ok: false, error: new Error(`cannot parse ${name}`), filePath: `${rootPath}/src/${name}` };
}

function newGraph(): GraphBuilder {
  const graph = new GraphBuilder();
  graph.addNode({ id: repoNodeId, label: "Repo", properties: { path: rootPath, name: "repo" } });
  return graph;
}

// Results in any arrival order give the graph and report of adding them in file order.
function addInOrder(results: ParseResult[], arrival: number[], continueOnError: boolean) {
  const graph = newGraph();
  const report = createScanReport(results.length, results.length, 0);
  const sink = new OrderedParseResults(graph, repoNodeId, rootPath, report, continueOnError);
  for (const index of arrival) sink.set(index, results[index]!);
  return { graph, report, complete: sink.complete };
}

function snapshot(graph: GraphBuilder, report: ReturnType<typeof createScanReport>) {
  return JSON.stringify({
    nodes: graph.nodes,
    relationships: graph.relationships,
    parsedFiles: report.parsedFiles,
    failed: report.failedFiles.map((failure) => failure.path),
    warnings: report.warnings,
  });
}

describe("scan memory", () => {
  it("adds parse results in file order whatever order they arrive in", () => {
    const results = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map(parsedFile);
    const graph = newGraph();
    const report = createScanReport(results.length, results.length, 0);
    assert.equal(addParseResultsToGraph(graph, repoNodeId, rootPath, results, report, true), true);
    const expected = snapshot(graph, report);

    for (const arrival of [[4, 3, 2, 1, 0], [1, 0, 3, 2, 4], [2, 4, 0, 1, 3]]) {
      const streamed = addInOrder(results, arrival, true);
      assert.equal(streamed.complete, true);
      assert.equal(snapshot(streamed.graph, streamed.report), expected, `arrival ${arrival.join(",")}`);
    }
  });

  it("adds a result as soon as the results before it are in", () => {
    const results = ["a.ts", "b.ts", "c.ts"].map(parsedFile);
    const graph = newGraph();
    const report = createScanReport(3, 3, 0);
    const sink = new OrderedParseResults(graph, repoNodeId, rootPath, report, true);
    sink.set(1, results[1]!);
    assert.equal(report.parsedFiles, 0, "b.ts waits for a.ts");
    sink.set(0, results[0]!);
    assert.equal(report.parsedFiles, 2);
    sink.set(2, results[2]!);
    assert.equal(report.parsedFiles, 3);
  });

  it("stops at the first failed file without continueOnError, as the held results did", () => {
    const results = [parsedFile("a.ts"), failedFile("b.ts"), parsedFile("c.ts"), failedFile("d.ts")];
    for (const continueOnError of [false, true]) {
      const graph = newGraph();
      const report = createScanReport(results.length, results.length, 0);
      const complete = addParseResultsToGraph(graph, repoNodeId, rootPath, results, report, continueOnError);
      const streamed = addInOrder(results, [3, 2, 1, 0], continueOnError);
      assert.equal(streamed.complete, complete);
      assert.equal(complete, continueOnError);
      assert.equal(snapshot(streamed.graph, streamed.report), snapshot(graph, report));
    }
    const stopped = addInOrder(results, [2, 0, 1, 3], false);
    assert.deepEqual(stopped.report.failedFiles.map((failure) => failure.path), ["src/b.ts"]);
    assert.equal(stopped.report.parsedFiles, 1);
  });

  it("checks bash and powershell in the helper process with the same result as here", async () => {
    const cases: Array<[Parameters<typeof syntaxErrorLines>[0], string]> = [
      ["bash", "#!/bin/sh\necho ok\n"],
      ["bash", "if [ -f x ]; then\n  echo x\n"],
      ["bash", "echo $((1 +))\nfi\nesac\n"],
      ["powershell", "Write-Host 'ok'\n"],
      ["powershell", "function Broken {\n  Write-Host (\n}\n"],
    ];
    for (const [grammar, source] of cases) {
      const here = await syntaxErrorLinesHere(grammar, source, 5);
      assert.deepEqual(await syntaxErrorLines(grammar, source, 5), here, `${grammar}: ${JSON.stringify(source)}`);
    }
    assert.ok((await syntaxErrorLines("powershell", "function Broken {\n  Write-Host (\n}\n", 5)).length > 0, "the broken script has errors");
    const concurrent = await Promise.all(cases.map(([grammar, source]) => syntaxErrorLines(grammar, source, 5)));
    assert.deepEqual(concurrent, await Promise.all(cases.map(([grammar, source]) => syntaxErrorLinesHere(grammar, source, 5))));
  });

  it("collects garbage between scan steps without failing", () => {
    collectGarbageAfterGrowth();
    collectGarbageAfterGrowth();
  });
});
