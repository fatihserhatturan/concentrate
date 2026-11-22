import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { BuildCodeGraphResult } from "../src/core/scan/result.js";
import { splitChain } from "../src/integrations/languages/csharp/receiver-chain.js";

// Phase 44 review fixes (calls and resolution): generic arity, shadowing by local functions and locals, partial methods,
// usings per namespace block, `var` inference, verbatim identifiers and the size of stored call text.

async function scanFiles(files: Record<string, string>, keepCallSites = true): Promise<BuildCodeGraphResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cs-review-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
    return await buildCodeGraph(dir, { continueOnError: true, concurrency: 2, keepCallSites });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// `N.Box.Get` out of `file:a.cs:function:12:N.Box.Get`; `@12` appended when `withLine` (tells overloads and `Box<T>` apart).
const label = (id: string, withLine = false): string => {
  const match = /:function:(\d+):(.*)$/su.exec(id);
  return match ? `${match[2]}${withLine ? `@${match[1]}` : ""}` : id;
};

// The targets (qualified names, `(via)` marked, sorted) of every call written as `expression` inside `caller`.
function targets(result: BuildCodeGraphResult, caller: string, expression: string, withLine = false): string[][] {
  const byCall = new Map<string, string[]>();
  for (const rel of result.relationships) {
    if (rel.type === "CALL_RESOLVES_TO") byCall.set(rel.from, [...byCall.get(rel.from) ?? [], label(rel.to, withLine) + (rel.properties.via ? ` (${String(rel.properties.via)})` : "")]);
  }
  const found: string[][] = [];
  for (const node of result.nodes) {
    if (node.label !== "Call") continue;
    const match = /:function:\d+:(.*?):call:\d+:\d+:(.*)$/su.exec(node.id);
    if (match && match[1] === caller && match[2] === expression) found.push((byCall.get(node.id) ?? []).sort());
  }
  assert.ok(found.length > 0, `call ${expression} in ${caller}`);
  return found;
}

const one = (result: BuildCodeGraphResult, caller: string, expression: string, withLine = false): string[] => targets(result, caller, expression, withLine)[0]!;

const edges = (result: BuildCodeGraphResult, type: string): string[] =>
  result.relationships
    .filter((rel) => rel.type === type)
    .map((rel) => `${rel.from.replace(/^.*:(?:class|interface):\d+:/u, "")} -> ${rel.to.replace(/^.*:(?:class|interface):\d+:/u, "")}`)
    .sort();

describe("C# review fixes: generic arity", () => {
  it("never falls back to the arity-less type when the use site is generic", async () => {
    const result = await scanFiles({
      "a.cs": `namespace N;
public class Stack { public Stack() {} }
public class Q : Stack<int> {}
public class P { void M() { var s = new Stack<int>(); } void Plain() { var s = new Stack(); } }
`,
    });
    assert.deepEqual(one(result, "N.P.M", "new Stack"), []);
    assert.deepEqual(one(result, "N.P.Plain", "new Stack"), ["N.Stack.Stack"]);
    assert.deepEqual(edges(result, "EXTENDS"), []);
  });

  it("picks `Box<T>` for `new Box<string>(..)`, for an alias to `Box<int>` and carries the arguments through a `new` receiver", async () => {
    const result = await scanFiles({
      "a.cs": `namespace N;
public class Box { public Box(int a) {} }
public class Box<T> { public Box(string s) {} public T Get() => default!; }
public class Item { public void Live() {} }
public class Q2 : Box<int> {}
`,
      "b.cs": `using IntBox = N.Box<int>;
using N;
class R {
  void M() { var a = new Box<string>("a"); var b = new IntBox("x"); var c = new Box(1); }
  void Chain() { new Box<Item>("x").Get().Live(); }
}
`,
    });
    // Line 2 is the plain `Box(int)`, line 3 the `Box<T>(string)` (an overload of one name and count is told apart by line).
    const [generic, alias, plain] = targets(result, "R.M", "new Box", true).concat(targets(result, "R.M", "new IntBox", true)).sort((left, right) => 0 * left.length * right.length);
    void generic; void alias; void plain;
    assert.deepEqual(targets(result, "R.M", "new Box", true).map((list) => list.map((item) => item.replace(/^N\.Box\.Box/u, "ctor"))).sort(), [["ctor@2"], ["ctor@3"]]);
    assert.deepEqual(one(result, "R.M", "new IntBox", true).map((item) => item.replace(/^N\.Box\.Box/u, "ctor")), ["ctor@3"]);
    assert.deepEqual(edges(result, "EXTENDS").map((edge) => edge.replace(/^.*?Q2 -> /u, "Q2 -> ")), ["Q2 -> N.Box"].map((edge) => edge));
    // `new Box<Item>("x").Get().Live()`: Get returns a `T` that is the `Item` the `new` was written with.
    assert.deepEqual(one(result, "R.Chain", "new Box<Item>(\"x\").Get().Live"), ["N.Item.Live"]);
    const q2 = result.relationships.find((rel) => rel.type === "EXTENDS");
    assert.match(q2?.to ?? "", /:class:3:N\.Box$/u);
  });
});

describe("C# review fixes: shadowing", () => {
  it("does not resolve a bare call named like a local function, a delegate local or a delegate parameter", async () => {
    const result = await scanFiles({
      "a.cs": `using System;
using static N.Util;
namespace N {
  static class Util { public static void Pick() {} }
  class Foo {
    void Helper() {}
    void Run() { void Helper() {} Helper(); }
    void Param(Action Helper) { Helper(); }
    void Local() { Action Helper = () => {}; Helper(); }
    void Ok() { Helper(); }
    void Static() { void Pick() {} Pick(); }
    void StaticOk() { Pick(); }
    void Count() {}
    void Typed() { int Count = 1; Count(); }
  }
}
`,
    });
    assert.deepEqual(one(result, "N.Foo.Run", "Helper"), []);
    assert.deepEqual(one(result, "N.Foo.Param", "Helper"), []);
    assert.deepEqual(one(result, "N.Foo.Local", "Helper"), []);
    assert.deepEqual(one(result, "N.Foo.Ok", "Helper"), ["N.Foo.Helper"]);
    assert.deepEqual(one(result, "N.Foo.Static", "Pick"), []);
    assert.deepEqual(one(result, "N.Foo.StaticOk", "Pick"), ["N.Util.Pick"]);
    // An int named like a method does not hide it: only an invocable local does.
    assert.deepEqual(one(result, "N.Foo.Typed", "Count"), ["N.Foo.Count"]);
  });

  it("treats a local that shares its name with a field as unknown, but a parameter wins", async () => {
    const result = await scanFiles({
      "a.cs": `namespace N;
class A { public void Live() {} }
class B { public void Live() {} }
class C {
  B x = new B();
  void Sibling() { { A x = new A(); } x.Live(); }
  void Inner() { A x = new A(); x.Live(); }
  void Param(A x) { x.Live(); }
  void Field() { x.Live(); }
}
`,
    });
    assert.deepEqual(one(result, "N.C.Sibling", "x.Live"), []);
    assert.deepEqual(one(result, "N.C.Inner", "x.Live"), []);
    assert.deepEqual(one(result, "N.C.Param", "x.Live"), ["N.A.Live"]);
    assert.deepEqual(one(result, "N.C.Field", "x.Live"), ["N.B.Live"]);
  });

  it("leaves `new T()` of a type parameter unresolved", async () => {
    const result = await scanFiles({
      "a.cs": `namespace N;
class T { public T() {} }
class F {
  public static T Create<T>() where T : new() { return new T(); }
  public static T Real() { return new T(); }
}
`,
    });
    assert.deepEqual(one(result, "N.F.Create", "new T"), []);
    assert.deepEqual(one(result, "N.F.Real", "new T"), ["N.T.T"]);
  });
});

describe("C# review fixes: members", () => {
  it("links a partial method call to the implementing part only", async () => {
    const result = await scanFiles({
      "a.cs": `partial class PM { partial void Hook(); void Run() { Hook(); } }
`,
      "b.cs": `partial class PM {
  partial void Hook() { }
}
`,
    });
    assert.deepEqual(one(result, "PM.Run", "Hook", true), ["PM.Hook@2"]);
  });

  it("keeps a partial declaration without an implementation as the target", async () => {
    const result = await scanFiles({ "a.cs": "partial class PM { partial void Hook(); void Run() { Hook(); } }\n" });
    assert.deepEqual(one(result, "PM.Run", "Hook"), ["PM.Hook"]);
  });

  it("does not add a derived `new` method that does not re-implement the interface", async () => {
    const result = await scanFiles({
      "a.cs": `namespace N;
interface I { void Run(); }
class C : I { public void Run() {} }
class D : C { public new void Run() {} }
class E : C, I { public new void Run() {} }
class U { void M(I i) { i.Run(); } }
`,
    });
    assert.deepEqual(one(result, "N.U.M", "i.Run"), ["N.C.Run (override)", "N.E.Run (override)", "N.I.Run"]);
  });

  it("types `var x = Method();`, `var x = obj.Prop;` and `var x = await M();` from the resolved type", async () => {
    const result = await scanFiles({
      "a.cs": `using System.Threading.Tasks;
namespace N;
class Live { public void Go() {} }
class Sup {
  public static Live Make() => new Live();
  public Live Prop { get; }
  public static Task<Live> MakeAsync() => Task.FromResult(new Live());
}
class P {
  Sup sup = new Sup();
  Live Own() => new Live();
  async Task M() {
    var s = Sup.Make(); s.Go();
    var p = sup.Prop; p.Go();
    var a = await Sup.MakeAsync(); a.Go();
    var o = Own(); o.Go();
    var u = Unknown(); u.Go();
  }
}
`,
    });
    assert.equal(targets(result, "N.P.M", "s.Go").length, 1);
    for (const call of ["s.Go", "p.Go", "a.Go", "o.Go"]) assert.deepEqual(one(result, "N.P.M", call), ["N.Live.Go"], call);
    assert.deepEqual(one(result, "N.P.M", "u.Go"), []);
  });
});

describe("C# review fixes: names and scopes", () => {
  it("resolves `global::` receivers and verbatim identifiers alike", async () => {
    const result = await scanFiles({
      "a.cs": `namespace N {
  static class Util { public static void Run() {} }
  class @class { public void Go() {} public void @event() {} }
  class P {
    void M() {
      global::N.Util.Run();
      var c = new @class(); c.Go(); c.@event();
      @class d = null; d.Go();
      N.@class.Hold();
    }
  }
}
`,
    });
    assert.deepEqual(one(result, "N.P.M", "global::N.Util.Run"), ["N.Util.Run"]);
    assert.deepEqual(one(result, "N.P.M", "new class"), []);
    assert.deepEqual(targets(result, "N.P.M", "c.Go")[0], ["N.class.Go"]);
    assert.deepEqual(targets(result, "N.P.M", "c.event")[0], ["N.class.event"]);
    assert.deepEqual(targets(result, "N.P.M", "d.Go")[0], ["N.class.Go"]);
    assert.ok(result.nodes.some((node) => node.label === "Class" && node.properties.qualifiedName === "N.class"));
  });

  it("scopes usings to their own namespace block when a file opens one namespace twice", async () => {
    const result = await scanFiles({
      "types.cs": `namespace X { public class Foo { public void Run() {} } }
namespace Y { public class Foo { public void Run() {} } }
`,
      "a.cs": `namespace A { using X; class C1 { void M() { new Foo().Run(); } } }
namespace A { using Y; class C2 { void M() { new Foo().Run(); } } }
`,
    });
    assert.deepEqual(one(result, "A.C1.M", "new Foo().Run"), ["X.Foo.Run"]);
    assert.deepEqual(one(result, "A.C2.M", "new Foo().Run"), ["Y.Foo.Run"]);
    const imports = result.nodes.filter((node) => node.label === "Import" && node.properties.usingScope === "A");
    assert.equal(imports.length, 2);
    assert.ok(imports.every((node) => typeof node.properties.usingScopeStart === "number" && typeof node.properties.usingScopeEnd === "number"));
  });

  it("keeps a visible extension namespace when an inner block aliases it", async () => {
    const result = await scanFiles({
      "ext.cs": `namespace Ext { public static class E { public static void Go(this App.Foo f) {} } }\n`,
      "app.cs": `using Ext;
namespace App {
  using E = Ext;
  class Foo {}
  class P { void M(Foo f) { f.Go(); } }
}
`,
    });
    assert.deepEqual(one(result, "App.P.M", "f.Go"), ["Ext.E.Go"]);
  });
});

describe("C# review fixes: size of stored call text", () => {
  it("splits a long chain in linear time", () => {
    const chain = `new Self()${".Self()".repeat(5000)}`;
    const started = performance.now();
    const segments = splitChain(chain);
    const elapsed = performance.now() - started;
    assert.equal(segments?.length, 5001);
    assert.ok(elapsed < 250, `splitChain took ${elapsed}ms`);
  });

  it("caps the receiver and expression text of calls and keeps the ids unique", async () => {
    // The grammar keeps only the first links of a chain this long (the rest is a syntax error, the statement is skipped); the cap holds for them.
    const chain = `new Self()${".ChainedWithALongName()".repeat(5000)}`;
    const started = performance.now();
    const result = await scanFiles({ "a.cs": `class Self { public Self ChainedWithALongName() => this; void Run() { ${chain}; } }\n` });
    const elapsed = performance.now() - started;
    const calls = result.nodes.filter((node) => node.label === "Call");
    assert.ok(calls.length >= 40);
    assert.ok(calls.every((node) => String(node.properties.expression).length <= 200 && String(node.properties.receiver ?? "").length <= 1000));
    assert.equal(new Set(calls.map((node) => node.id)).size, calls.length);
    assert.ok(calls.some((node) => node.properties.receiverTruncated === true));
    assert.ok(elapsed < 5000, `scan took ${elapsed}ms`);
  });
});

describe("C# review fixes: unresolved calls", () => {
  it("counts local function, delegate and indexed calls as unresolved calls of the enclosing method", async () => {
    const result = await scanFiles({
      "a.cs": `using System;
class K {
  void Run(Action cb, int[] list) {
    void Local() {}
    Local();
    cb();
    list[0].ToString();
  }
}
`,
    }, false);
    const run = result.nodes.find((node) => node.label === "Function" && node.properties.name === "Run");
    const unresolved = JSON.parse(String(run?.properties.unresolvedCalls ?? "[]")) as Array<[string, number, string]>;
    assert.deepEqual(unresolved.map((item) => item[0]).sort(), ["Local", "ToString", "cb"]);
  });
});
