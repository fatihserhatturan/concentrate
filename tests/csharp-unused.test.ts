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
import { stripCSharpComments } from "../src/integrations/languages/csharp/unused.js";
import { openTestStore } from "./helpers/store.js";

const label = (entry: { name: string; className?: string }) => (entry.className ? `${entry.className}.${entry.name}` : entry.name);

async function open(root: string, dir: string, name: string): Promise<GraphStore> {
  const graph = await buildCodeGraph(dir, { continueOnError: false });
  const store = await openTestStore(path.join(root, name));
  await store.reset();
  await store.write(graph.nodes, graph.relationships);
  return store;
}

describe("C# unused exports (fixtures/csharp-unused)", () => {
  let root: string;
  let store: GraphStore;
  const run = async (target: GraphStore = store, args: Record<string, unknown> = {}) => findUnusedExports(target, args, pageWindow("find_unused_exports", args, 50));

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-unused-"));
    store = await open(root, path.resolve("fixtures/csharp-unused"), "graph");
  });
  after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reports public, internal and private types and members nothing uses", async () => {
    const result = await run();
    assert.deepEqual(result.unusedExports.map(label).sort(), [
      "Attributed",
      "IntExt.Triple",
      "UnusedEnum",
      "UnusedInternalClass",
      "UnusedPublicClass",
      "UsedPublic.UnusedInternal",
      "UsedPublic.UnusedMethod",
      "UsedPublic.UnusedPrivate",
      "UsedPublic.UnusedProp",
      "UsedPublic.unusedField",
    ]);
  });

  it("keeps used members, overrides, interface implementations, attributed declarations, tests and Main", async () => {
    const reported = new Set((await run()).unusedExports.map(label));
    for (const kept of [
      "UsedPublic", "UsedPublic.UsedMethod", "UsedPublic.UsedInternal", "UsedPublic.UsedProp", "UsedInternalClass", "IThing", "ThingImpl",
      "ThingImpl.Do", "ThingImpl.ToString", "UsedEnum", "IntExt", "IntExt.Double", "Program", "Program.Main", "Attributed.MarkedMethod",
      "MarkedClass", "MarkerAttribute", "SomeTests", "SomeTests.NeverCalledDirectly",
    ]) assert.equal(reported.has(kept), false, kept);
  });

  it("names C# in the tool note", () => {
    const note = unusedNote(coreIntegrationRegistry);
    assert.ok(note.includes("C#: public, internal"), note);
    assert.ok(/ and C#\.$/u.test(note), note);
  });

  it("judges partial members, explicit and external interface implementations, and generated code", async () => {
    const project = path.join(root, "project");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src/Widget.cs"), [
      "namespace App;",
      "public partial class Widget : System.IDisposable, IShown",
      "{",
      "    public void Dispose() { Helper(); }",
      "    void IShown.Show() { }",
      "    private void OnlyInOtherPart() { }",
      "    private void NeverCalled() { }",
      "    public void Public() { }",
      "}",
      "public interface IShown { void Show(); }",
      "",
    ].join("\n"));
    await writeFile(path.join(project, "src/Widget.Part.cs"), [
      "namespace App;",
      "public partial class Widget",
      "{",
      "    private void Helper() { OnlyInOtherPart(); }",
      "}",
      "",
    ].join("\n"));
    await writeFile(path.join(project, "src/Model.g.cs"), "namespace App;\npublic class Generated { public void Never() { } }\n");
    await writeFile(path.join(project, "src/Strings.cs"), "namespace App;\npublic class Strings { // NeverCalled in a comment\n  public string S = @\"// Public\"; }\n");
    const partial = await open(root, project, "partial");
    try {
      const reported = (await run(partial)).unusedExports.map(label).sort();
      // Public is kept by a string mention (a name in a string may be a reflective use); a comment mention does not count.
      // Dispose implements a BCL interface, Show is explicit, Helper and OnlyInOtherPart are used inside the type's other part.
      assert.deepEqual(reported, ["Strings", "Strings.S", "Widget.NeverCalled"]);
    } finally {
      await partial.close();
    }
  });

  it("keeps overrides, virtual members and a static class reached only through an extension call", async () => {
    const project = path.join(root, "project2");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "A.cs"), [
      "namespace App;",
      "public abstract class Base { public virtual void Hook() { } public abstract void Must(); }",
      "public class Derived : Base",
      "{",
      "    public override void Must() { }",
      "    public override string ToString() => \"d\";",
      "}",
      "public static class TextExt { public static string Shout(this string s) => s; }",
      "public class Caller { public static void Main() { _ = new Derived(); _ = \"x\".Shout(); } }",
      "",
    ].join("\n"));
    const target = await open(root, project, "overrides");
    try {
      assert.deepEqual((await run(target)).unusedExports.map(label).sort(), []);
    } finally {
      await target.close();
    }
  });

  it("strips comments but keeps strings", () => {
    assert.equal(stripCSharpComments("a // b\nc /* d */ e \"//x\" @\"//y\" 'z'").replace(/\s+/gu, " "), "a c e \"//x\" @\"//y\" 'z'");
  });
});
