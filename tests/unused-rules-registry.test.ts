import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { findUnusedExports, unusedNote } from "../src/adapters/mcp/analysis-tools/unused.js";
import { pageWindow } from "../src/adapters/mcp/paging.js";
import type { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { createDefaultCoreIntegrationRegistry } from "../src/composition/default-registry.js";
import { createEmptyCoreIntegrationRegistry, describeIntegrations } from "../src/core/integrations/registry.js";
import { openTestStore } from "./helpers/store.js";
import { createToyRegistry, toyUnusedRules } from "./helpers/toy-plugin.js";

const NOTE_TAIL = "JavaScript, TypeScript, Python, Go, Rust, C and C++.";

describe("unused-export rules through the registry", () => {
  let root: string;
  let store: GraphStore;
  const run = async (registry = createDefaultCoreIntegrationRegistry()) => {
    const result = await findUnusedExports(store, {}, pageWindow("find_unused_exports", {}, 50), registry);
    return { names: result.unusedExports.map((entry) => entry.name).sort(), note: result.note };
  };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-unused-rules-"));
    const project = path.join(root, "project");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src", "a.ts"), "import { used } from './b';\nexport function main() {\n  return used();\n}\n");
    await writeFile(path.join(project, "src", "b.ts"), "export function used() {\n  return 1;\n}\nexport function lonely() {\n  return 2;\n}\n");
    const graph = await buildCodeGraph(project, { continueOnError: false });
    store = await openTestStore(path.join(root, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("registers the five languages in note order, and rejects a duplicate id", () => {
    const registry = createDefaultCoreIntegrationRegistry();
    assert.deepEqual(registry.unusedExportRules.map((rules) => rules.id), ["js-ts", "go", "rust", "python", "cpp"]);
    assert.throws(() => registry.registerUnusedExportRules(registry.unusedExportRules[0]!), /already registered/);
    assert.ok(describeIntegrations(registry).includes("unused-rules:go@"));
    assert.deepEqual(createEmptyCoreIntegrationRegistry().unusedExportRules, []);
  });

  it("derives the default note's language list from the registered rules", async () => {
    const { names, note } = await run();
    assert.deepEqual(names, ["lonely", "main"]);
    assert.ok(note.endsWith(` ${NOTE_TAIL}`), note);
  });

  it("shows an extra rule in the note and the registry, leaving other languages' results alone", async () => {
    const registry = createToyRegistry();
    assert.equal(registry.unusedExportRules.at(-1), toyUnusedRules);
    assert.ok(describeIntegrations(registry).includes("unused-rules:toy@"));
    const { names, note } = await run(registry);
    assert.deepEqual(names, ["lonely", "main"]);
    assert.ok(note.includes(toyUnusedRules.note!), note);
    assert.ok(note.endsWith("C, C++ and toy."), note);
  });

  it("judges only what the registry's rules cover", async () => {
    const registry = createEmptyCoreIntegrationRegistry();
    registry.registerUnusedExportRules({ id: "nothing-public", languages: ["typescript"], supports: (file) => file.endsWith(".ts"), isPublicApi: () => false, note: "Nothing." });
    const { names, note } = await run(registry);
    assert.deepEqual(names, []);
    assert.ok(note.endsWith("Nothing. TypeScript."), note);
    assert.equal(unusedNote([]).endsWith("."), true);
  });
});
