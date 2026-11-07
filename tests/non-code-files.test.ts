import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { detectLanguage } from "../src/core/scan/language.js";
import { classifyFile } from "../src/core/scan/file-classification.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = Awaited<ReturnType<typeof buildCodeGraph>>;

describe("non-code files in the graph", () => {
  let graph: Graph;
  let files: Map<string, GraphNode>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/non-code-files"), { continueOnError: false });
    files = new Map(graph.nodes.filter((node) => node.label === "File").map((node) => [String(node.properties.relativePath), node]));
  });

  it("detects the language of a file by extension or name", () => {
    const expected: Array<[string, string]> = [
      ["a.css", "css"], ["a.scss", "scss"], ["a.less", "less"], ["a.json", "json"], ["a.yml", "yaml"], ["a.toml", "toml"],
      ["a.md", "markdown"], ["a.sh", "shell"], ["a.ps1", "powershell"], ["Dockerfile", "dockerfile"], ["Dockerfile.prod", "dockerfile"],
      ["Makefile", "makefile"], ["a.sql", "sql"], ["a.proto", "proto"], ["a.png", "asset"], ["a.PNG", "asset"], ["LICENSE", "other"],
      ["a.ts", "typescript"], ["a.py", "python"],
    ];
    for (const [file, language] of expected) assert.equal(detectLanguage(file), language, file);
  });

  it("makes every discovered file a File node and counts code files apart from the rest", () => {
    assert.equal(files.size, graph.report.discoveredFiles);
    assert.equal(graph.report.supportedFiles, 2);
    assert.equal(graph.report.otherFiles, 19);
    assert.equal(graph.report.skippedFiles, 0);
    assert.equal(graph.report.parsedFiles, 2);
    const languages = Object.fromEntries([...files].map(([file, node]) => [file, node.properties.language]));
    assert.equal(languages["Dockerfile"], "dockerfile");
    assert.equal(languages["scripts/deploy.ps1"], "powershell");
    assert.equal(languages["db/schema.sql"], "sql");
    assert.equal(languages["src/assets/banner.png"], "asset");
    assert.equal(languages["notes.txt"], "other");
    assert.equal(languages["src/main.ts"], "typescript");
  });

  it("classifies docs and lockfiles, and keeps other files production", () => {
    const type = (file: string) => files.get(file)!.properties.sourceType;
    for (const file of ["README.md", "LICENSE", "docs/guide.md", "notes.txt"]) assert.equal(type(file), "docs", file);
    assert.equal(type("package-lock.json"), "generated");
    assert.equal(type("package.json"), "production");
    assert.equal(type("src/styles/app.css"), "production");
    assert.deepEqual(graph.report.fileClassifications, { production: 16, test: 0, fixture: 0, support: 0, generated: 1, docs: 4 });
  });

  it("keeps example code under docs/ as production code", () => {
    assert.equal(classifyFile("docs/examples/app.ts", false, true).sourceType, "production");
    assert.equal(classifyFile("docs/examples/app.md", false, false).sourceType, "docs");
  });

  it("resolves imports of styles, JSON, images, new URL() and HTML links to the File", () => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const importer = new Map(graph.relationships.filter((rel) => rel.type === "IMPORTS").map((rel) => [rel.to, rel.from]));
    const edges = (graph.relationships as GraphRelationship[])
      .filter((rel) => rel.type === "RESOLVES_TO")
      .map((rel) => `${byId.get(importer.get(rel.from)!)?.properties.relativePath} -> ${byId.get(rel.to)?.properties.relativePath}`)
      .sort();
    assert.deepEqual(edges, [
      "index.html -> src/main.ts",
      "index.html -> src/styles/app.css",
      "src/main.ts -> src/assets/banner.png",
      "src/main.ts -> src/assets/logo.svg",
      "src/main.ts -> src/config.json",
      "src/main.ts -> src/styles/app.css",
      "src/main.ts -> src/styles/theme.scss",
    ]);
    // `./styles/missing.css` names no file.
    assert.equal(graph.report.unresolvedRelativeImports, 1);
  });

  it("treats an unknown file with a NUL byte as an asset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-plain-"));
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "data/blob.dat"), Buffer.from([1, 2, 0, 3]));
    await writeFile(path.join(root, "data/text.dat"), "hello\n");
    const result = await buildCodeGraph(root, { continueOnError: false });
    const language = (file: string) => result.nodes.find((node) => node.label === "File" && node.properties.relativePath === file)?.properties.language;
    assert.equal(language("data/blob.dat"), "asset");
    assert.equal(language("data/text.dat"), "other");
  });

  it("limits code files with maxFiles but keeps the other files", async () => {
    const limited = await buildCodeGraph(path.resolve("fixtures/non-code-files"), { continueOnError: false, maxFiles: 1 });
    assert.equal(limited.report.supportedFiles, 1);
    assert.equal(limited.report.otherFiles, 19);
  });
});
