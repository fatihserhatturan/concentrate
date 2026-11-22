import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { findUnusedExports, unusedNote } from "../src/adapters/mcp/analysis-tools/unused.js";
import { pageWindow } from "../src/adapters/mcp/paging.js";
import type { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { coreIntegrationRegistry } from "../src/composition/default-registry.js";
import { stripJavaComments } from "../src/integrations/languages/java/unused.js";
import { openTestStore } from "./helpers/store.js";

describe("Java unused exports (fixtures/java-unused)", () => {
  let root: string;
  let store: GraphStore;
  const run = async (args: Record<string, unknown> = {}) => findUnusedExports(store, args, pageWindow("find_unused_exports", args, 50));
  const label = (entry: { name: string; className?: string }) => (entry.className ? `${entry.className}.${entry.name}` : entry.name);

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-unused-"));
    const graph = await buildCodeGraph(path.resolve("fixtures/java-unused"), { continueOnError: false });
    store = await openTestStore(path.join(root, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reports package-private and private types, methods and fields nothing uses", async () => {
    const result = await run();
    assert.deepEqual(result.unusedExports.map(label).sort(), [
      "Dead",
      "Dead.nothing",
      "Facade.cache",
      "Facade.orphan",
      "Main.unusedStatic",
      "PublicApi.pkgOnly",
      "PublicApi.secret",
    ]);
    assert.deepEqual(result.deadFunctions, []);
  });

  it("keeps public API, overrides, interface members and entry points", async () => {
    const result = await run();
    const reported = new Set(result.unusedExports.map(label));
    for (const kept of ["PublicApi", "PublicApi.exposed", "PublicApi.hook", "UsedApi.neverCalled", "Unused", "Unused.util", "Impl.extra", "Impl.handle", "Impl.unimplementedHook", "Impl.toString", "Main.main", "Handler", "Internal", "UsedApi.pkgUsed", "Internal.go", "Facade.helper"]) {
      assert.equal(reported.has(kept), false, kept);
    }
  });

  it("skips annotated, serialization and constructor members, and counts same-package and test uses", async () => {
    const project = path.join(root, "project");
    await mkdir(path.join(project, "src/main/java/app"), { recursive: true });
    await mkdir(path.join(project, "src/test/java/app"), { recursive: true });
    await writeFile(path.join(project, "src/main/java/app/Svc.java"), [
      "package app;",
      "class Svc implements java.io.Serializable {",
      "  private static final long serialVersionUID = 1L;",
      "  @Inject private Object injected;",
      "  private int plain;",
      "  Svc() {}",
      "  @PostConstruct void init() {}",
      "  private void readObject(java.io.ObjectInputStream in) {}",
      "  void forTests() {}",
      "  // forTests is only mentioned in a comment here",
      "  enum Mode { A, B }",
      "  private enum Hidden { X }",
      "}",
      "",
    ].join("\n"));
    await writeFile(path.join(project, "src/test/java/app/SvcTest.java"), "package app;\nclass SvcTest {\n  void t() { new Svc().forTests(); }\n}\n");
    const graph = await buildCodeGraph(project, { continueOnError: false });
    const projectStore = await openTestStore(path.join(root, "graph2"));
    try {
      await projectStore.reset();
      await projectStore.write(graph.nodes, graph.relationships);
      const result = await findUnusedExports(projectStore, {}, pageWindow("find_unused_exports", {}, 50));
      assert.deepEqual(result.unusedExports.map(label).sort(), ["Hidden", "Mode", "Svc.plain"]);
    } finally {
      await projectStore.close();
    }
  });

  it("keeps a member with a non-ASCII name that another method uses", async () => {
    const project = path.join(root, "unicode");
    await mkdir(path.join(project, "app"), { recursive: true });
    await writeFile(path.join(project, "app/Cafe.java"), [
      "package app;",
      "class Cafe {",
      "  private String café() { return \"x\"; }",
      "  private void dead() {}",
      "  String order() { return café(); }",
      "}",
      "",
    ].join("\n"));
    const graph = await buildCodeGraph(project, { continueOnError: false });
    const projectStore = await openTestStore(path.join(root, "graph3"));
    try {
      await projectStore.reset();
      await projectStore.write(graph.nodes, graph.relationships);
      const result = await findUnusedExports(projectStore, {}, pageWindow("find_unused_exports", {}, 50));
      const reported = result.unusedExports.map(label);
      assert.equal(reported.includes("Cafe.café"), false, reported.join());
      assert.equal(reported.includes("Cafe.dead"), true, reported.join());
    } finally {
      await projectStore.close();
    }
  });

  it("issues no decorator queries for a project without Java", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/go-basic"), { continueOnError: false });
    const goStore = await openTestStore(path.join(root, "graph4"));
    try {
      await goStore.reset();
      await goStore.write(graph.nodes, graph.relationships);
      const queries: string[] = [];
      const recording = { query: (text: string, ...rest: unknown[]) => { queries.push(text); return (goStore.query as (...args: unknown[]) => Promise<unknown[]>)(text, ...rest); } } as unknown as typeof goStore;
      await findUnusedExports(recording, {}, pageWindow("find_unused_exports", {}, 50));
      assert.ok(queries.length > 0);
      assert.equal(queries.filter((text) => /DECORATOR/u.test(text)).length, 0);
    } finally {
      await goStore.close();
    }
  });

  it("names the language in the tool note", () => {
    const note = unusedNote(coreIntegrationRegistry);
    assert.ok(note.includes("Java: public and protected"), note);
    assert.ok(/ Java and C#\.$/u.test(note), note);
  });

  it("strips comments but keeps strings", () => {
    assert.equal(stripJavaComments("a // b\nc /* d */ e \"//x\" 'y'").replace(/\s+/gu, " "), "a c e \"//x\" 'y'");
  });
});
