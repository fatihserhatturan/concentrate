import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { scanIntoStore } from "../src/adapters/cli/scan.js";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { openGraphStore } from "../src/composition/graph-store.js";
import { detectLanguage } from "../src/core/scan/language.js";
import { loadProjectSettings, parseProjectSettings } from "../src/core/scan/project-settings.js";

describe("concentrate.json", () => {
  it("parses every key and rejects what it cannot use", () => {
    const settings = parseProjectSettings({ extensions: { ".MJSX": "javascript" }, include: ["src/**"], exclude: ["**/*.gen.ts"], deprioritize: ["legacy/**"], apiOrigins: ["https://api.example.com"] });
    assert.equal(settings.extensions.get(".mjsx"), "javascript");
    assert.deepEqual([settings.include, settings.exclude, settings.deprioritize, settings.apiOrigins], [["src/**"], ["**/*.gen.ts"], ["legacy/**"], ["https://api.example.com"]]);
    assert.throws(() => parseProjectSettings([]), /must be a JSON object/u);
    assert.throws(() => parseProjectSettings({ exclud: [] }), /unknown key exclud/u);
    assert.throws(() => parseProjectSettings({ extensions: { ".x": "klingon" } }), /unknown language "klingon"/u);
    assert.throws(() => parseProjectSettings({ extensions: { x: "go" } }), /must start with a dot/u);
    assert.throws(() => parseProjectSettings({ include: "src" }), /list of non-empty strings/u);
  });

  it("reads nothing when the file is missing and names a broken file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-settings-"));
    assert.deepEqual((await loadProjectSettings(root)).include, []);
    await writeFile(path.join(root, "concentrate.json"), "{ nope");
    await assert.rejects(() => loadProjectSettings(root), /concentrate\.json: /u);
  });

  it("lets an override beat the built-in extension table", () => {
    assert.equal(detectLanguage("a.mjsx"), "other");
    assert.equal(detectLanguage("a.mjsx", new Map([[".mjsx", "javascript"]])), "javascript");
    assert.equal(detectLanguage("a.ts", new Map([[".ts", "javascript"]])), "javascript");
  });

  it("scans with the file's extensions, excludes and deprioritize", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-settings-scan-"));
    const project = path.join(root, "project");
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "settings-app" }),
      "concentrate.json": JSON.stringify({ extensions: { ".mjsx": "javascript" }, exclude: ["generated/**"], deprioritize: ["legacy/**"] }),
      "src/view.mjsx": "export function renderView() { return 1; }\n",
      "src/format.ts": "export function formatThing() { return 2; }\n",
      "legacy/format.ts": "export function formatThing() { return 3; }\n",
      "generated/skip.ts": "export function skipped() { return 4; }\n",
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project, file)), { recursive: true });
      await writeFile(path.join(project, file), text);
    }
    const database = path.join(root, "graph");
    const options = { database, continueOnError: false, include: [], exclude: [], retryLock: true, cacheDir: path.join(root, "cache"), manifest: path.join(root, "m.json") };
    await scanIntoStore(project, options);
    // A second scan reads the parse cache: the language is part of its key.
    await scanIntoStore(project, options);
    const store = await openGraphStore(database);
    try {
      const rows = await store.query("MATCH (file:File) RETURN file.relativePath AS file, file.language AS language") as Array<Record<string, string>>;
      const byFile = new Map(rows.map((row) => [row.file, row.language]));
      assert.equal(byFile.get("src/view.mjsx"), "javascript");
      assert.equal(byFile.has("generated/skip.ts"), false);
      const view = (await callMcpTool(store, "find_definitions", { name: "renderView" })).structuredContent as any;
      assert.equal(view.definitions.length, 1);

      const search = (await callMcpTool(store, "search_symbols", { query: "formatThing" })).structuredContent as any;
      assert.deepEqual(search.symbols.map((symbol: any) => [symbol.file, symbol.deprioritized]), [["src/format.ts", undefined], ["legacy/format.ts", true]]);
    } finally {
      await store.close();
    }
  });
});
