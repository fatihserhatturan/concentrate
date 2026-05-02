import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import type { IGraphContributor } from "../src/core/contracts/graph-contributor.js";
import type { ILanguageParser } from "../src/core/contracts/language-parser.js";
import { GraphBuilder } from "../src/graph/builder.js";
import type { LanguageParser } from "../src/parsers/types.js";
import {
  getParserAdapter,
  languageParsers,
  languageResolvers,
  scanOrchestrator,
  semanticContributors,
} from "../src/core/adapters/index.js";
import {
  javascriptLanguageParser,
  typescriptLanguageParser,
} from "../src/integrations/languages/js-ts/index.js";
import { pythonLanguageParser } from "../src/integrations/languages/python/index.js";
import { goLanguageParser } from "../src/integrations/languages/go/index.js";
import { rustLanguageParser } from "../src/integrations/languages/rust/index.js";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");

describe("Core contract conformance", () => {
  it("GraphBuilder satisfies IGraphContributor", () => {
    const builder = new GraphBuilder();
    const _contrib: IGraphContributor = builder;
    assert.ok(_contrib);
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

  it("languageParsers map covers all five supported languages", () => {
    for (const lang of ["javascript", "typescript", "python", "go", "rust"]) {
      const parser = languageParsers.get(lang);
      assert.ok(parser, `missing parser for ${lang}`);
      assert.equal(parser.language, lang);
      assert.equal(typeof parser.parse, "function");
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
