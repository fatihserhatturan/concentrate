import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { BuildCodeGraphResult } from "../src/core/scan/result.js";

const scan = (directory: string) => buildCodeGraph(path.resolve(directory), { continueOnError: true, concurrency: 2, keepCallSites: true });

// `Util/MathUtil.cs::Acme.Util.MathUtil.Square` style labels for function ids (the line is dropped).
const functionLabel = (id: string) => id.replace(/^file:/u, "").replace(/:function:\d+:/u, "::");

// call label (`Acme.App.Service.Run MathUtil.Square`) -> the targets of each call with that label, `(override)` / `(overload)` marked.
function callTargets(result: BuildCodeGraphResult): Map<string, string[][]> {
  const byCall = new Map<string, string[]>();
  for (const rel of result.relationships) {
    if (rel.type !== "CALL_RESOLVES_TO") continue;
    byCall.set(rel.from, [...byCall.get(rel.from) ?? [], functionLabel(rel.to) + (rel.properties.via ? ` (${String(rel.properties.via)})` : "")]);
  }
  const resolved = new Map<string, string[][]>();
  for (const node of result.nodes) {
    if (node.label !== "Call") continue;
    const key = functionLabel(node.id).replace(/^[^:]*::/u, "").replace(/:call:\d+:\d+:/u, " ");
    resolved.set(key, [...resolved.get(key) ?? [], (byCall.get(node.id) ?? []).sort()]);
  }
  return resolved;
}

const one = (calls: Map<string, string[][]>, key: string, position = 0): string[] => {
  const found = calls.get(key);
  assert.ok(found && found.length > position, `call ${key}`);
  return found[position]!;
};

const edges = (result: BuildCodeGraphResult, type: string): string[] =>
  result.relationships
    .filter((rel) => rel.type === type)
    .map((rel) => `${rel.from.replace(/^.*:(?:class|interface):\d+:/u, "")} -> ${rel.to.replace(/^.*:(?:class|interface):\d+:/u, "")}`)
    .sort();

describe("C# calls: csharp-calls fixture", () => {
  let result: BuildCodeGraphResult;
  let calls: Map<string, string[][]>;
  before(async () => {
    result = await scan("fixtures/csharp-calls");
    calls = callTargets(result);
  });

  const run = (expression: string) => `Acme.App.Service.Run ${expression}`;
  const square = "Util/MathUtil.cs::Acme.Util.MathUtil.Square";

  it("resolves static, qualified and using-imported calls", () => {
    assert.deepEqual(one(calls, run("MathUtil.Square")), [square]);
    assert.deepEqual(one(calls, run("Acme.Util.MathUtil.Square")), [square]);
    assert.deepEqual(one(calls, run("Greetings.Hello")), ["Util/Greetings.cs::Acme.Util.Greetings.Hello"]);
  });

  it("resolves `using static` members and tells overloads apart by argument count", () => {
    const sums = calls.get(run("Sum"))!;
    assert.equal(sums.length, 2);
    for (const targets of sums) assert.ok(targets.length === 1 && targets[0]!.endsWith("MathUtil.Sum"), targets.join());
    // Two arguments and three arguments reach different overloads.
    const ids = result.nodes.filter((node) => node.label === "Call" && node.properties.expression === "Sum").map((node) => ({
      args: node.properties.argumentCount,
      to: result.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.from === node.id).map((rel) => rel.to),
    }));
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0]!.to[0], ids[1]!.to[0]);
    const parameterCount = (id: string) => result.nodes.find((node) => node.id === id)!.properties.parameterCount;
    for (const entry of ids) assert.equal(parameterCount(entry.to[0]!), entry.args);
  });

  it("narrows Fmt(1, \"a\") to the two overloads that accept the arguments, both marked, none guessed", () => {
    const fmt = one(calls, run("Fmt"));
    // Fmt(string, int) cannot take (int, string): the argument types drop it. Fmt(int, string) and Fmt(object, object) stay.
    assert.equal(fmt.length, 2, fmt.join());
    assert.ok(fmt.every((target) => target.startsWith("Util/MathUtil.cs::Acme.Util.MathUtil.Fmt") && target.endsWith("(overload)")), fmt.join());
  });

  it("resolves fields, properties, parameters, var, target-typed new, this and chains through return types", () => {
    const print = ["Shapes/Shape.cs::Acme.Shapes.Printer.Print"];
    for (const expression of ["_printer.Print", "p.Print", "local.Print", "t.Print"]) assert.deepEqual(one(calls, run(expression)), print, expression);
    assert.deepEqual(one(calls, run("Current.Area")), ["Shapes/Shape.cs::Acme.Shapes.Circle.Area"]);
    assert.deepEqual(one(calls, run("this.Helper")), ["Program.cs::Acme.App.Service.Helper"]);
    const chain = "new Printer().Print(\"a\").Self().Inner()";
    assert.deepEqual(one(calls, run("new Printer().Print")), print);
    assert.deepEqual(one(calls, run("new Printer().Print(\"a\").Self")), ["Shapes/Shape.cs::Acme.Shapes.Printer.Self"]);
    assert.deepEqual(one(calls, run("new Printer().Print(\"a\").Self().Inner")), ["Shapes/Shape.cs::Acme.Shapes.Printer.Inner"]);
    assert.deepEqual(one(calls, run(`${chain}.Done`)), ["Shapes/Shape.cs::Acme.Shapes.Stack.Done"]);
  });

  it("resolves extension methods on string literals and typed receivers", () => {
    assert.deepEqual(one(calls, run("\"hi\".Shout")), ["Ext/StringExtensions.cs::Acme.Ext.StringExtensions.Shout"]);
    assert.deepEqual(one(calls, run("str.WordCount")), ["Ext/StringExtensions.cs::Acme.Ext.StringExtensions.WordCount"]);
  });

  it("marks interface, abstract and virtual dispatch as override", () => {
    const area = [
      "Shapes/Shape.cs::Acme.Shapes.Circle.Area (override)",
      "Shapes/Shape.cs::Acme.Shapes.IShape.Area",
      "Shapes/Shape.cs::Acme.Shapes.ShapeBase.Area (override)",
      "Shapes/Shape.cs::Acme.Shapes.Square.Area (override)",
    ];
    assert.deepEqual(one(calls, run("s.Area")), area);
    assert.deepEqual(one(calls, run("_shape.Area")), area);
    assert.deepEqual(one(calls, run("b.Describe")), ["Shapes/Shape.cs::Acme.Shapes.Circle.Describe (override)", "Shapes/Shape.cs::Acme.Shapes.ShapeBase.Describe"]);
    // Abstract call inside the base class: every override below it.
    assert.deepEqual(one(calls, "Acme.Shapes.ShapeBase.Describe Area"), [
      "Shapes/Shape.cs::Acme.Shapes.Circle.Area (override)",
      "Shapes/Shape.cs::Acme.Shapes.ShapeBase.Area",
      "Shapes/Shape.cs::Acme.Shapes.Square.Area (override)",
    ]);
  });

  it("resolves base and inherited implicit-this calls without dispatch", () => {
    assert.deepEqual(one(calls, "Acme.App.Derived.Go base.Run"), ["Program.cs::Acme.App.Service.Run"]);
    assert.deepEqual(one(calls, "Acme.App.Derived.Go Run"), ["Program.cs::Acme.App.Service.Run"]);
    assert.deepEqual(one(calls, "Acme.Shapes.Circle.Describe base.Describe"), ["Shapes/Shape.cs::Acme.Shapes.ShapeBase.Describe"]);
  });

  it("leaves System, unknown and untyped receivers unresolved", () => {
    for (const expression of ["Console.WriteLine", "str.ToUpper", "Math.Max", "unknownReceiver.Mystery", "Phantom.Go"]) assert.deepEqual(one(calls, run(expression)), [], expression);
    assert.deepEqual(one(calls, "Acme.Ext.StringExtensions.Shout s.ToUpperInvariant"), []);
    assert.deepEqual(one(calls, "Acme.Shapes.Printer.Print System.Console.WriteLine"), []);
    // A class with no explicit constructor has no Function to point at.
    assert.deepEqual(one(calls, run("new Printer")), []);
  });

  it("adds EXTENDS and IMPLEMENTS between the types of the scan", () => {
    assert.deepEqual(edges(result, "EXTENDS"), ["Acme.App.Derived -> Acme.App.Service", "Acme.Shapes.Circle -> Acme.Shapes.ShapeBase", "Acme.Shapes.Square -> Acme.Shapes.ShapeBase"]);
    assert.deepEqual(edges(result, "IMPLEMENTS"), ["Acme.Shapes.ShapeBase -> Acme.Shapes.IShape"]);
  });
});

describe("C# calls: csharp-declarations fixture", () => {
  let result: BuildCodeGraphResult;
  before(async () => {
    result = await scan("fixtures/csharp-declarations");
  });

  it("merges the partial Widget declarations into one node with every base and file", () => {
    const widgets = result.nodes.filter((node) => node.label === "Class" && node.properties.name === "Widget");
    assert.equal(widgets.length, 1);
    const bases = JSON.parse(String(widgets[0]!.properties.bases)) as Array<{ name: string }>;
    assert.deepEqual(bases.map((base) => base.name), ["Animal", "IWalker"]);
    const files = result.relationships.filter((rel) => rel.type === "DEFINES_CLASS" && rel.to === widgets[0]!.id).map((rel) => rel.from).sort();
    assert.deepEqual(files, ["file:Partial.A.cs", "file:Partial.B.cs", "file:Partial.C.cs"]);
    assert.deepEqual(edges(result, "EXTENDS").filter((edge) => edge.startsWith("csharp:partial:Acme.Decl.Widget")), ["csharp:partial:Acme.Decl.Widget -> Acme.Decl.Animal"]);
    assert.deepEqual(edges(result, "IMPLEMENTS").filter((edge) => edge.startsWith("csharp:partial:Acme.Decl.Widget")), ["csharp:partial:Acme.Decl.Widget -> Acme.Decl.IWalker"]);
  });

  it("links classes to their base class and interfaces; interface bases stay on the node", () => {
    const extendsEdges = edges(result, "EXTENDS");
    assert.ok(extendsEdges.includes("Acme.Decl.Duck -> Acme.Decl.Animal"));
    assert.ok(extendsEdges.includes("Acme.Decl.Employee -> Acme.Decl.Person"));
    const implementsEdges = edges(result, "IMPLEMENTS");
    assert.ok(implementsEdges.includes("Acme.Decl.Duck -> Acme.Decl.IWalker"));
    assert.ok(implementsEdges.includes("Acme.Decl.Duck -> Acme.Decl.ISwimmer"));
    assert.ok(!extendsEdges.some((edge) => edge.startsWith("Acme.Decl.IWalker")), "no interface EXTENDS edge");
  });
});

describe("C# calls: namespaces, aliases, generics, constructors, dispatch (inline project)", () => {
  let directory: string;
  let calls: Map<string, string[][]>;
  let result: BuildCodeGraphResult;
  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "csharp-calls-"));
    await mkdir(path.join(directory, "Core"));
    await mkdir(path.join(directory, "App"));
    await writeFile(path.join(directory, "Core", "Core.cs"), `namespace Corp.Core
{
    public class Box<T>
    {
        public T Value;
        public T Get() => Value;
        public Box<T> Self() => this;
    }
    public class Box<TA, TB> { public void Pair() { } }
    public class Item { public Item() { } public Item(int x) { } public void Touch() { } }
    public interface IRepo { void Save(Item i); }
    public class SqlRepo : IRepo { public void Save(Item i) { } }
    public class ExplicitRepo : IRepo { void IRepo.Save(Item i) { } }
    public class Outer
    {
        public class Inner { public void Run() { } }
        public Inner Make() => new Inner();
        public void Use() { var i = new Inner(); i.Run(); Make().Run(); }
    }
    public class Base { public Base(int a) { } public Base() { } }
    public class Child : Base
    {
        public Child() : base(1) { }
        public Child(int x) : this() { }
    }
    public static class Ext
    {
        public static void Twice(this Item i, int n) { }
        public static T Pick<T>(this T t) where T : Item => t;
        public static int Count2(this System.Collections.Generic.IEnumerable<int> src) => 0;
    }
}
namespace Corp.Hidden
{
    public static class HiddenExt { public static void Secret(this Corp.Core.Item i) { } }
}
`);
    await writeFile(path.join(directory, "App", "GlobalUsings.cs"), "global using Corp.Core;\n");
    await writeFile(path.join(directory, "App", "Main.cs"), `using Boxes = Corp.Core.Box<int>;
using C = Corp.Core;
namespace Corp.App
{
    public class Main1
    {
        public void Go()
        {
            var b = new Boxes();
            var item = new Item();
            item.Touch();
            Box<Item> bi = new Box<Item>();
            bi.Get().Touch();
            bi.Self().Get().Touch();
            C.Item x = new C.Item();
            x.Touch();
            item.Twice(2);
            Ext.Twice(item, 2);
            item.Pick().Touch();
            item.Secret();
            IRepo r = new SqlRepo();
            r.Save(item);
            new Item(1);
            var o = new Outer();
            o.Make().Run();
            Corp.Core.Outer.Inner inn = new Outer.Inner();
            inn.Run();
            ((IRepo)r).Save(item);
            (r as SqlRepo).Save(item);
            new List<int>().Count2();
        }
    }
}
`);
    result = await scan(directory);
    calls = callTargets(result);
  });
  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const go = (expression: string, position = 0) => one(calls, `Corp.App.Main1.Go ${expression}`, position);
  const core = "Core/Core.cs::Corp.Core";

  it("resolves a type through a global using, an alias and a namespace alias", () => {
    assert.deepEqual(go("item.Touch"), [`${core}.Item.Touch`]);
    assert.deepEqual(go("x.Touch"), [`${core}.Item.Touch`]);
  });

  it("resolves constructors by argument count", () => {
    // `new Item()` and `new Item(1)`: the two constructors, told apart by argument count (no overload mark).
    const [zero, one1] = [go("new Item", 0), go("new Item", 1)];
    assert.equal(zero.length, 1);
    assert.equal(one1.length, 1);
    assert.notEqual(zero[0], one1[0]);
    for (const target of [...zero, ...one1]) assert.ok(target.startsWith(`${core}.Item.Item`) && !target.includes("(overload)"), target);
    assert.equal(go("new C.Item").length, 1);
    assert.equal(go("new Boxes", 0).length, 0, "Box has no explicit constructor");
  });

  it("follows generic arguments through members, and picks the type by arity", () => {
    // bi: Box<Item>: Get() returns T = Item.
    assert.deepEqual(go("bi.Get"), [`${core}.Box.Get`]);
    assert.deepEqual(go("bi.Get().Touch"), [`${core}.Item.Touch`]);
    assert.deepEqual(go("bi.Self().Get().Touch"), [`${core}.Item.Touch`]);
  });

  it("resolves nested types, extension methods in scope, static-form extension calls and explicit chaining", () => {
    assert.deepEqual(go("inn.Run"), [`${core}.Outer.Inner.Run`]);
    assert.deepEqual(go("o.Make().Run"), [`${core}.Outer.Inner.Run`]);
    assert.deepEqual(one(calls, "Corp.Core.Outer.Use i.Run"), [`${core}.Outer.Inner.Run`]);
    assert.deepEqual(one(calls, "Corp.Core.Outer.Use Make().Run"), [`${core}.Outer.Inner.Run`]);
    assert.deepEqual(go("item.Twice"), [`${core}.Ext.Twice`]);
    assert.deepEqual(go("Ext.Twice"), [`${core}.Ext.Twice`]);
    assert.deepEqual(go("item.Pick"), [`${core}.Ext.Pick`]);
    assert.deepEqual(go("item.Pick().Touch"), [`${core}.Item.Touch`]);
    // A System collection reaches an extension written on IEnumerable<int>.
    assert.deepEqual(go("new List<int>().Count2"), [`${core}.Ext.Count2`]);
  });

  it("does not use an extension method whose namespace is not in scope", () => {
    assert.deepEqual(go("item.Secret"), []);
  });

  it("dispatches interface calls to implementations, including explicit interface implementations; casts type the receiver", () => {
    const targets = [`${core}.ExplicitRepo.Save (override)`, `${core}.IRepo.Save`, `${core}.SqlRepo.Save (override)`];
    assert.deepEqual(go("r.Save"), targets);
    assert.deepEqual(go("((IRepo)r).Save"), targets);
    // `(r as SqlRepo).Save`: the class itself, no dispatch.
    assert.deepEqual(go("(r as SqlRepo).Save"), [`${core}.SqlRepo.Save`]);
  });

  it("resolves this(...) and base(...) initializers by argument count", () => {
    const initializers = result.nodes.filter((node) => node.label === "Call" && node.properties.callKind === "explicitConstructor");
    assert.equal(initializers.length, 2);
    for (const node of initializers) {
      const targets = result.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.from === node.id).map((rel) => functionLabel(rel.to));
      assert.equal(targets.length, 1, String(node.properties.name));
      if (node.properties.callee === "base") assert.ok(targets[0]!.endsWith("Corp.Core.Base.Base"));
      else assert.ok(targets[0]!.endsWith("Corp.Core.Child.Child"));
    }
  });
});
