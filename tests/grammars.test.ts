import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { parseSyntaxTree, withSyntaxTree, type GrammarName } from "../src/integrations/languages/syntax/tree-sitter.js";

const grammarsDirectory = path.resolve("vendor/grammars");

type Manifest = { cli: string; grammars: Record<string, { package: string; version: string; sha256: string; bytes: number }> };

describe("vendored grammars", () => {
  it("match vendor/grammars/manifest.json (rebuild with npm run grammars:build)", async () => {
    const manifest = JSON.parse(await readFile(path.join(grammarsDirectory, "manifest.json"), "utf8")) as Manifest;
    const files = (await readdir(grammarsDirectory)).filter((file) => file.endsWith(".wasm")).sort();
    assert.deepEqual(files, Object.keys(manifest.grammars).map((name) => `${name}.wasm`).sort());

    for (const [name, entry] of Object.entries(manifest.grammars)) {
      const bytes = await readFile(path.join(grammarsDirectory, `${name}.wasm`));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${name}.wasm differs from the manifest`);
    }
  });

  it("parse each language", async () => {
    const samples: Record<GrammarName, [string, string]> = {
      javascript: ["const a = f(1);", "lexical_declaration"],
      typescript: ["let a: number = f(1);", "lexical_declaration"],
      tsx: ["let a = <A b={f(1)} />;", "lexical_declaration"],
      python: ["a = f(1)", "expression_statement"],
      go: ["package main\nfunc main() {}", "package_clause"],
      rust: ["fn main() {}", "function_item"],
    };
    const manifest = JSON.parse(await readFile(path.join(grammarsDirectory, "manifest.json"), "utf8")) as Manifest;

    for (const name of Object.keys(manifest.grammars) as GrammarName[]) {
      const [source, firstStatement] = samples[name];
      const type = await withSyntaxTree(name, source, (tree) => {
        assert.equal(tree.rootNode.hasError, false, name);
        return tree.rootNode.namedChildren[0]?.type;
      });
      assert.equal(type, firstStatement, name);
    }
  });

  it("parses sources larger than the old 32 KB native input limit", async () => {
    const source = Array.from({ length: 4000 }, (_, index) => `const value${index} = ${index};`).join("\n");
    const tree = await parseSyntaxTree("javascript", source);
    try {
      assert.equal(tree.rootNode.namedChildren.length, 4000);
      assert.equal(tree.rootNode.hasError, false);
    } finally {
      tree.delete();
    }
  });
});
