import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

describe("styles in the MCP tools", () => {
  let store: GraphStore;
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-styles-"));
    const graph = await buildCodeGraph(path.resolve("fixtures/styles-links"), { continueOnError: false });
    store = await GraphStore.open(path.join(root, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> =>
    JSON.parse((await callMcpTool(store, name, args)).content[0]!.text) as Record<string, any>;

  it("find_references on a class lists its rules and users, exact for CSS Modules", async () => {
    const result = await call("find_references", { symbol: ".btn" });
    assert.deepEqual(result.declarations, [{ name: ".btn", kind: "class", file: "src/react/Button.module.css", line: 1, scope: "module" }]);
    assert.deepEqual(result.counts, { rule: 2, "component-use": 1 });
    assert.deepEqual(result.references.map((reference: any) => [reference.kind, reference.file, reference.line, reference.from ?? null, reference.detail, reference.possible ?? false]), [
      ["rule", "src/react/Button.module.css", 1, null, ".btn", false],
      ["rule", "src/react/Button.module.css", 3, null, ".btn:hover .icon", false],
      ["component-use", "src/react/Button.tsx", 7, "Button", "styles.btn, module match", false],
    ]);
  });

  it("marks matches by name possible, and finds ids and custom properties by prefix", async () => {
    const note = await call("find_references", { symbol: ".note" });
    assert.deepEqual(note.references.filter((reference: any) => reference.kind.endsWith("-use")).map((reference: any) => [reference.from ?? reference.file, reference.target, reference.possible ?? false]), [
      ["public/index.html", "public/site.css:3", false],
      ["Card", "public/site.css:3", true],
      ["Card", "src/react/global.css:1", true],
    ]);
    const id = await call("find_references", { symbol: "#app" });
    assert.deepEqual(id.declarations, []);
    const property = await call("find_references", { symbol: "--panel-color" });
    assert.deepEqual(property.references.map((reference: any) => [reference.kind, reference.file, reference.detail]), [["var", "src/vue/Panel.vue", "var(--panel-color), name match"]]);
  });

  it("impact_of on a class reaches the components that use it and those that render them", async () => {
    const result = await call("impact_of", { symbol: ".btn" });
    assert.deepEqual(result.users.map((user: any) => [user.as, user.name, user.match, user.expression]), [["component", "Button", "module", "styles.btn"]]);
    assert.deepEqual(result.components.map((component: any) => [component.name, component.depth]), [["Button", 0], ["Card", 1]]);
    assert.deepEqual(result.rules.map((rule: any) => rule.selector), [".btn", ".btn:hover .icon"]);
  });

  it("impact_of on a style file covers the classes it declares; on a custom property it reaches the importing components", async () => {
    const sheet = await call("impact_of", { file: "src/react/card.css" });
    assert.deepEqual(sheet.styles.map((style: any) => style.name), [".card", ".title", ".loading"]);
    assert.deepEqual([...new Set(sheet.components.map((component: any) => component.name))].sort(), ["Button", "Card"]);

    const property = await call("impact_of", { symbol: "--panel-color" });
    assert.deepEqual(property.styles.map((style: any) => [style.name, style.file]), [["--panel-color", "public/site.css"]]);
    assert.deepEqual(property.users.map((user: any) => [user.as, user.name, user.match]), [["file", "src/vue/Panel.vue", "name"]]);
    assert.deepEqual(property.components.map((component: any) => [component.name, component.depth]), [["Panel", 0]]);
  });

  it("says when nothing matches", async () => {
    const result = await call("impact_of", { symbol: ".nope" });
    assert.deepEqual(result.styles, []);
    assert.match(result.note, /No class, id or custom property/u);
  });
});
