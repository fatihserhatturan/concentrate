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

  it("keeps a record built only with new, whose primary constructor is no extra mention", async () => {
    const project = path.join(root, "project-records");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "A.cs"), [
      "namespace App;",
      "public record Rec(int A);",
      "public record struct Point(int X);",
      "public sealed class Holder(int n) { public int N => n; }",
      "public record Never(int A);",
      "public class Caller { public static void Main() { _ = new Rec(1); _ = new Point(1); _ = new Holder(1); } }",
      "",
    ].join("\n"));
    const target = await open(root, project, "records");
    try {
      assert.deepEqual((await run(target)).unusedExports.map(label).sort(), ["Holder.N", "Never"]);
    } finally {
      await target.close();
    }
  });

  it("never reports the duck-typed members the language binds by name, unless private", async () => {
    const project = path.join(root, "project-duck");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "A.cs"), [
      "namespace App;",
      "public class Bag",
      "{",
      "    public Bag GetEnumerator() => this;",
      "    public bool MoveNext() => false;",
      "    public int Current => 0;",
      "    public void Deconstruct(out int a) { a = 0; }",
      "    public Bag GetAwaiter() => this;",
      "    public bool IsCompleted => true;",
      "    public void GetResult() { }",
      "    public void Dispose() { }",
      "    public void Add(int x) { }",
      "    public int Length => 0;",
      "    public Bag Slice(int a, int b) => this;",
      "    public Bag Select(System.Func<int, int> f) => this;",
      "    public Bag Where(System.Func<int, bool> f) => this;",
      "    internal Bag OrderBy(System.Func<int, int> f) => this;",
      "    protected Bag Cast() => this;",
      "    public override bool Equals(object? o) => false;",
      "    public new string ToString() => \"\";",
      "    private void Add(string x) { }",
      "    private int Count => 0;",
      "    public void Plain() { }",
      "}",
      "public class Caller { public static void Main() { _ = new Bag(); } }",
      "",
    ].join("\n"));
    const target = await open(root, project, "duck");
    try {
      assert.deepEqual((await run(target)).unusedExports.map(label).sort(), ["Bag.Count", "Bag.Plain"]);
    } finally {
      await target.close();
    }
  });

  it("holds a type only for an entrypoint Main: an instance Main or a generic type's Main keeps nothing", async () => {
    const project = path.join(root, "project-main");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "A.cs"), [
      "namespace App;",
      "public class Real { static int Main(string[] args) => 0; }",
      "public class Instance { public void Main() { } }",
      "public class Generic<T> { public static void Main() { } }",
      "public class BadArgs { public static void Main(int x) { } }",
      "",
    ].join("\n"));
    const target = await open(root, project, "main");
    try {
      assert.deepEqual((await run(target)).unusedExports.map(label).sort(), ["BadArgs", "Generic", "Instance"]);
    } finally {
      await target.close();
    }
  });

  it("skips non-verbatim interpolated strings whole, nested strings and escapes included", () => {
    const code = "var s = $\"x {(b ? \"y\" : \"//\")} z {{ // }}\"; Baz(); // gone\nQux();";
    const stripped = stripCSharpComments(code);
    assert.ok(stripped.includes("Baz();"));
    assert.ok(stripped.includes("Qux();"));
    assert.ok(!stripped.includes("gone"));
    assert.ok(stripped.includes("$\"x {(b ? \"y\" : \"//\")} z {{ // }}\""));
    assert.ok(stripCSharpComments("$@\"a {x} // b\"; Q();").includes("Q();"));
    assert.ok(stripCSharpComments("var t = $\"{Foo($\"{a}\")}\"; Z(); // c").includes("Z();"));
  });
});
