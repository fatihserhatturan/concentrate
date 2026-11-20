import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createDefaultCoreIntegrationRegistry, createLanguageTable } from "../src/composition/default-registry.js";
import { createScanDependencies } from "../src/composition/orchestrator.js";
import type { ILanguageCallResolver } from "../src/core/contracts/call-resolver.js";
import type { LanguageDescriptor } from "../src/core/contracts/language-descriptor.js";
import type { ILanguageParser } from "../src/core/contracts/language-parser.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { buildCodeGraph } from "../src/core/scan/orchestrator.js";

// A language added entirely outside src/core: a descriptor, a parser and a call
// resolver. `fn name` declares a function, `call name` calls one.

const toyDescriptor: LanguageDescriptor = { id: "toy", code: true, extensions: [".toy"] };

const toyParser: ILanguageParser = {
  language: "toy",
  async parse(rootPath, filePath) {
    const relativePath = path.relative(rootPath, filePath);
    const fileNodeId = `file:${relativePath}`;
    const nodes: GraphNode[] = [{ id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language: "toy" } }];
    const relationships: GraphRelationship[] = [];
    let currentFunction: string | null = null;
    const lines = (await readFile(filePath, "utf8")).split("\n");
    lines.forEach((text, index) => {
      const [keyword, name] = text.trim().split(/\s+/u);
      if (keyword === "fn" && name) {
        const id = `${fileNodeId}:function:${name}`;
        nodes.push({ id, label: "Function", properties: { name, qualifiedName: name, line: index + 1 } });
        relationships.push({ from: fileNodeId, to: id, type: "DEFINES_FUNCTION", properties: {} });
        currentFunction = id;
      } else if (keyword === "call" && name && currentFunction) {
        const id = `${currentFunction}:call:${index + 1}:${name}`;
        nodes.push({ id, label: "Call", properties: { name, expression: name, callee: name, receiver: null, line: index + 1, columnNumber: 0 } });
        relationships.push({ from: currentFunction, to: id, type: "CALLS", properties: {} });
      }
    });
    return { fileNodeId, nodes, relationships };
  },
};

const toyCallResolver: ILanguageCallResolver = {
  id: "toy",
  supports: (fileId) => fileId.endsWith(".toy"),
  createSession(graph) {
    const byName = new Map(graph.nodesWithLabel("Function").map((node) => [String(node.properties.name), node.id]));
    return (call) => {
      const target = byName.get(String(call.properties.callee));
      return target ? [{ functionId: target }] : [];
    };
  },
};

describe("a language registered outside core", () => {
  it("is detected, parsed and call-resolved without edits to src/core", async () => {
    const registry = createDefaultCoreIntegrationRegistry();
    registry.registerLanguage(toyDescriptor);
    registry.registerLanguageParser(toyParser);
    registry.registerCallResolver(toyCallResolver);
    const languages = createLanguageTable(registry);
    assert.equal(languages.detect("x/a.toy"), "toy");
    assert.equal(languages.isCode("toy"), true);
    assert.equal(languages.codeLanguages.has("toy"), true);
    assert.equal(languages.detect("x/a.ts"), "typescript");

    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-toy-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "a.toy"), "fn main\ncall helper\n");
      await writeFile(path.join(root, "src", "b.toy"), "fn helper\n");
      // The extension is also valid in concentrate.json.
      await writeFile(path.join(root, "concentrate.json"), JSON.stringify({ extensions: { ".tz": "toy" } }));
      await writeFile(path.join(root, "src", "c.tz"), "fn extra\n");

      const result = await buildCodeGraph(root, { continueOnError: false, workers: 0, keepCallSites: true }, createScanDependencies(registry));
      const files = result.nodes.filter((node) => node.label === "File" && node.properties.language === "toy");
      assert.deepEqual(files.map((file) => file.properties.relativePath).sort(), [path.join("src", "a.toy"), path.join("src", "b.toy"), path.join("src", "c.tz")]);
      assert.equal(result.report.parsedFiles >= 3, true);

      const resolves = result.relationships.filter((relationship) => relationship.type === "CALL_RESOLVES_TO");
      assert.equal(resolves.length, 1);
      assert.match(resolves[0]!.to, /b\.toy:function:helper$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
