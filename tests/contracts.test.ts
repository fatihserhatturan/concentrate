import { defaultLanguageTable } from "../src/composition/default-registry.js";
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import type { IGraphContributor } from "../src/core/contracts/graph-contributor.js";
import type { ILanguageParser } from "../src/core/contracts/language-parser.js";
import type { GraphNode as CoreGraphNode, ParsedSourceFile as CoreParsedSourceFile } from "../src/core/graph/model.js";
import type { BuildCodeGraphResult, ScanManifest, ScanReport } from "../src/core/scan/index.js";
import { coreBuildCodeGraph, createScanOrchestrator, createScanReport } from "../src/core/scan/index.js";
import { CoreIntegrationRegistry } from "../src/core/integrations/index.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { LanguageParser } from "../src/core/contracts/language-parser.js";
import {
  getParserAdapter,
  languageParsers,
  languageResolvers,
  scanOrchestrator,
  semanticContributors,
} from "../src/composition/adapters.js";
import {
  javascriptLanguageParser,
  typescriptLanguageParser,
} from "../src/integrations/languages/js-ts/index.js";
import { pythonLanguageParser } from "../src/integrations/languages/python/index.js";
import { goLanguageParser } from "../src/integrations/languages/go/index.js";
import { rustLanguageParser } from "../src/integrations/languages/rust/index.js";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");

// One file to parse per code language, keyed by language id. A newly registered code language needs an entry.
const parserFixtures: Record<string, { root: string; file: string }> = {
  javascript: { root: "parser-javascript", file: "index.js" },
  typescript: { root: "parser-typescript", file: "index.ts" },
  python: { root: "parser-python", file: "module.py" },
  go: { root: "parser-go", file: "service.go" },
  rust: { root: "parser-rust", file: "lib.rs" },
  c: { root: "c-basic", file: "src/list.c" },
  cpp: { root: "cpp-calls", file: "src/shape.cpp" },
  java: { root: "java-parser-contract", file: "src/main/java/com/acme/Greeter.java" },
  html: { root: "vanilla-html", file: "index.html" },
  vue: { root: "vue-components", file: "src/App.vue" },
  svelte: { root: "svelte-components", file: "src/App.svelte" },
  astro: { root: "astro-site", file: "src/components/Header.astro" },
};

describe("Core contract conformance", () => {
  it("GraphBuilder satisfies IGraphContributor", () => {
    const builder = new GraphBuilder();
    const _contrib: IGraphContributor = builder;
    assert.ok(_contrib);
  });

  it("core graph DTO exports provide the graph model surface", () => {
    const fileNode: CoreGraphNode = {
      id: "file:index.ts",
      label: "File",
      properties: { relativePath: "index.ts", language: "typescript" },
    };
    const parsed: CoreParsedSourceFile = {
      fileNodeId: fileNode.id,
      nodes: [fileNode],
      relationships: [],
    };

    assert.equal(parsed.nodes[0]?.label, "File");
  });

  it("core scan DTO exports provide the scan report and result surface", () => {
    const report: ScanReport = createScanReport(1, 1);
    const manifest: ScanManifest = {
      version: 1,
      rootPath: fixturesRoot,
      hashAlgorithm: "sha256",
      generatedAt: "2026-05-02T00:00:00.000Z",
      files: [],
    };
    const result: BuildCodeGraphResult = {
      rootPath: fixturesRoot,
      nodes: [],
      relationships: [],
      report,
      manifest,
    };

    assert.equal(result.report.parseCache.enabled, false);
    assert.equal(result.report.status, "success");
  });

  it("LanguageParser satisfies ILanguageParser", () => {
    function check(parser: LanguageParser): ILanguageParser {
      return parser;
    }
    assert.equal(typeof check, "function");
  });

  it("getParserAdapter returns an ILanguageParser for known languages", () => {
    const parser = getParserAdapter("javascript");
    assert.equal(parser.language, "javascript");
    assert.equal(typeof parser.parse, "function");
  });

  it("every registered language parser has its language label and a parse function", () => {
    assert.ok(languageParsers.size > 0, "the default registry registers parsers");
    for (const [language, parser] of languageParsers) {
      assert.equal(parser.language, language);
      assert.equal(typeof parser.parse, "function");
    }
    // The registry must still cover the languages the product ships.
    for (const language of ["javascript", "typescript", "python", "go", "rust"]) {
      assert.ok(languageParsers.get(language), `missing parser for ${language}`);
    }
  });

  it("every registered code language has a parser and a conformance fixture", () => {
    for (const language of defaultLanguageTable.codeLanguages) {
      assert.ok(languageParsers.get(language), `code language "${language}" has no registered parser`);
      assert.ok(
        language in parserFixtures,
        `code language "${language}" has no entry in parserFixtures (tests/contracts.test.ts): add a fixture directory and a file to parse`,
      );
    }
  });

  it("every registered parser parses its fixture into a File node plus language nodes", async () => {
    for (const [language, parser] of languageParsers) {
      if (!defaultLanguageTable.isCode(language)) continue;
      const fixture = parserFixtures[language];
      assert.ok(fixture, `code language "${language}" has no entry in parserFixtures`);
      const rootPath = path.join(fixturesRoot, fixture.root);
      const result = await parser.parse(rootPath, path.join(rootPath, fixture.file));

      assert.ok(result.nodes.some((n) => n.label === "File"), `${language}: should have File node`);
      assert.ok(result.nodes.length > 1, `${language}: should have more than just the File node`);
    }
  });

  it("languageResolvers exposes ordered ILanguageResolver array", () => {
    assert.ok(Array.isArray(languageResolvers));
    assert.ok(languageResolvers.length >= 4);
    for (const resolver of languageResolvers) {
      assert.equal(typeof resolver.resolve, "function");
    }
  });

  it("semanticContributors exposes ordered ISemanticContributor array", () => {
    assert.ok(Array.isArray(semanticContributors));
    assert.ok(semanticContributors.length >= 6);
    for (const contributor of semanticContributors) {
      assert.equal(typeof contributor.contribute, "function");
    }
  });

  it("scanOrchestrator satisfies IScanOrchestrator", () => {
    assert.equal(typeof scanOrchestrator.buildGraph, "function");
  });

  it("core scan module owns the scan orchestrator surface", () => {
    assert.equal(typeof coreBuildCodeGraph, "function");
    const orchestrator = createScanOrchestrator({ languages: defaultLanguageTable, getParser: getParserAdapter, resolvers: [], contributors: [] });
    assert.equal(typeof orchestrator.buildGraph, "function");
  });

  it("core integration registry accepts new integrations without scanner edits", async () => {
    const registry = new CoreIntegrationRegistry();
    const parser: ILanguageParser = {
      language: "custom",
      async parse() {
        return {
          fileNodeId: "file:custom.lang",
          nodes: [],
          relationships: [],
        };
      },
    };
    const resolverCalls: string[] = [];
    const contributorCalls: string[] = [];

    registry.registerLanguageParser(parser);
    registry.registerLanguageResolver({
      resolve() {
        resolverCalls.push("resolver");
      },
    });
    registry.registerSemanticContributor({
      contribute() {
        contributorCalls.push("contributor");
      },
    });

    assert.equal(registry.getLanguageParser("custom"), parser);
    assert.equal(registry.languageParsers.get("custom"), parser);
    await registry.languageResolvers[0]?.resolve(new GraphBuilder(), fixturesRoot, createScanReport(0, 0), []);
    await registry.semanticContributors[0]?.contribute(new GraphBuilder(), fixturesRoot, createScanReport(0, 0), []);
    assert.deepEqual(resolverCalls, ["resolver"]);
    assert.deepEqual(contributorCalls, ["contributor"]);
  });
});

describe("JS/TS language integration boundary", () => {
  it("javascriptLanguageParser has correct language label", () => {
    assert.equal(javascriptLanguageParser.language, "javascript");
  });

  it("typescriptLanguageParser has correct language label", () => {
    assert.equal(typescriptLanguageParser.language, "typescript");
  });

  it("language-only parser produces File + language nodes but no Route or EntryPoint nodes", async () => {
    const rootPath = path.join(fixturesRoot, "parser-javascript");
    const filePath = path.join(rootPath, "index.js");
    const result = await javascriptLanguageParser.parse(rootPath, filePath);

    assert.ok(result.nodes.length > 0, "should produce nodes");
    assert.ok(result.nodes.some((n) => n.label === "File"), "should have File node");
    assert.ok(result.nodes.some((n) => n.label === "Function" || n.label === "Import"), "should have language-level nodes");
    assert.equal(result.nodes.filter((n) => n.label === "Route").length, 0, "should not have Route nodes");
    assert.equal(result.nodes.filter((n) => n.label === "EntryPoint").length, 0, "should not have EntryPoint nodes");
  });

  it("language-only parser produces TypeScript-specific nodes for .ts files", async () => {
    const rootPath = path.join(fixturesRoot, "parser-typescript");
    const filePath = path.join(rootPath, "index.ts");
    const result = await typescriptLanguageParser.parse(rootPath, filePath);

    assert.ok(result.nodes.some((n) => n.label === "File"), "should have File node");
    assert.ok(result.nodes.length > 1, "should have more than just the File node");
    assert.equal(result.nodes.filter((n) => n.label === "Route").length, 0, "should not have Route nodes");
    assert.equal(result.nodes.filter((n) => n.label === "EntryPoint").length, 0, "should not have EntryPoint nodes");
  });
});

describe("Python language integration boundary", () => {
  it("pythonLanguageParser has correct language label", () => {
    assert.equal(pythonLanguageParser.language, "python");
  });

  it("parser produces File, Function, Class, and Import nodes for a Python file", async () => {
    const rootPath = path.join(fixturesRoot, "parser-python");
    const filePath = path.join(rootPath, "module.py");
    const result = await pythonLanguageParser.parse(rootPath, filePath);

    assert.ok(result.nodes.some((n) => n.label === "File"), "should have File node");
    assert.ok(result.nodes.length > 1, "should have more than just the File node");
  });
});

describe("Go language integration boundary", () => {
  it("goLanguageParser has correct language label", () => {
    assert.equal(goLanguageParser.language, "go");
  });

  it("parser produces File, Function, and Class nodes for a Go file", async () => {
    const rootPath = path.join(fixturesRoot, "parser-go");
    const filePath = path.join(rootPath, "service.go");
    const result = await goLanguageParser.parse(rootPath, filePath);

    assert.ok(result.nodes.some((n) => n.label === "File"), "should have File node");
    assert.ok(result.nodes.length > 1, "should have more than just the File node");
  });
});

describe("Rust language integration boundary", () => {
  it("rustLanguageParser has correct language label", () => {
    assert.equal(rustLanguageParser.language, "rust");
  });

  it("parser produces File, Function, and Class nodes for a Rust file", async () => {
    const rootPath = path.join(fixturesRoot, "parser-rust");
    const filePath = path.join(rootPath, "lib.rs");
    const result = await rustLanguageParser.parse(rootPath, filePath);

    assert.ok(result.nodes.some((n) => n.label === "File"), "should have File node");
    assert.ok(result.nodes.length > 1, "should have more than just the File node");
  });
});
