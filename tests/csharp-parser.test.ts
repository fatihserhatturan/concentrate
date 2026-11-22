import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { GraphNode, ParsedSourceFile } from "../src/core/graph/model.js";
import { classifyFile } from "../src/core/scan/file-classification.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { defaultLanguageTable } from "../src/composition/default-registry.js";
import { isCSharpFile } from "../src/integrations/languages/file-kind.js";
import { csharpParser } from "../src/integrations/languages/csharp/parser.js";
import { normalizeCSharpType } from "../src/integrations/languages/csharp/syntax.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function parse(relativePath: string, source: string): Promise<ParsedSourceFile> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
  return csharpParser.parse(root, file);
}

const byLabel = (parsed: ParsedSourceFile, label: string) => parsed.nodes.filter((node) => node.label === label);
const named = (parsed: ParsedSourceFile, label: string, qualifiedName: string): GraphNode => {
  const node = parsed.nodes.find((candidate) => candidate.label === label && candidate.properties.qualifiedName === qualifiedName);
  assert.ok(node, `${label} ${qualifiedName}`);
  return node;
};
const field = (parsed: ParsedSourceFile, name: string): GraphNode => {
  const node = parsed.nodes.find((candidate) => candidate.label === "Field" && candidate.properties.name === name);
  assert.ok(node, `Field ${name}`);
  return node;
};
const calls = (parsed: ParsedSourceFile, expression: string) => byLabel(parsed, "Call").filter((node) => node.properties.expression === expression);
const related = (parsed: ParsedSourceFile, type: string, from: GraphNode) =>
  parsed.relationships.filter((relationship) => relationship.type === type && relationship.from === from.id).map((relationship) => parsed.nodes.find((node) => node.id === relationship.to)!);
const json = (value: unknown) => JSON.parse(String(value)) as unknown;

describe("C# descriptor", () => {
  it("claims .cs and .csx and marks generated names and obj/ as generated", () => {
    assert.equal(defaultLanguageTable.detect("src/Program.cs"), "csharp");
    assert.equal(defaultLanguageTable.detect("scripts/build.csx"), "csharp");
    assert.equal(defaultLanguageTable.isCode("csharp"), true);
    assert.equal(isCSharpFile("file:src/Program.cs"), true);
    assert.equal(isCSharpFile("file:src/Program.java"), false);
    const { conventions } = defaultLanguageTable;
    assert.equal(classifyFile("src/Model.g.cs", conventions).isGenerated, true);
    assert.equal(classifyFile("src/Model.g.i.cs", conventions).isGenerated, true);
    assert.equal(classifyFile("src/Form1.Designer.cs", conventions).isGenerated, true);
    assert.equal(classifyFile("src/App/obj/Debug/net8.0/App.AssemblyInfo.cs", conventions).isGenerated, true);
    assert.equal(classifyFile("src/Program.cs", conventions).isGenerated, false);
    assert.equal(classifyFile("src/objects/Program.cs", conventions).isGenerated, false);
    // The directory rule is C#'s, but it is a project-wide convention like the others.
    assert.equal(classifyFile("obj/x.ts", conventions).isGenerated, true);
  });
});

describe("normalizeCSharpType", () => {
  it("strips generic arguments, nullability and array ranks, and rejects non-names", () => {
    assert.equal(normalizeCSharpType("List<string>"), "List");
    assert.equal(normalizeCSharpType("System.Collections.Generic.Dictionary<string, List<int>>"), "System.Collections.Generic.Dictionary");
    assert.equal(normalizeCSharpType("Outer<int>.Inner"), "Outer.Inner");
    assert.equal(normalizeCSharpType("Foo?"), "Foo");
    assert.equal(normalizeCSharpType("global::A.B"), "A.B");
    assert.equal(normalizeCSharpType("Foo[,]"), "Foo[]");
    assert.equal(normalizeCSharpType("int"), "int");
    assert.equal(normalizeCSharpType("var"), null);
    assert.equal(normalizeCSharpType("(int a, string b)"), null);
    assert.equal(normalizeCSharpType("int*"), null);
  });
});

describe("C# parser: file, namespaces and usings", () => {
  it("emits a File node and the namespaces of block-scoped and file-scoped declarations", async () => {
    const block = await parse("Block.cs", `namespace A.B { namespace C { class X {} } class Y {} }\nclass Z {}`);
    assert.equal(block.nodes[0]!.label, "File");
    assert.equal(block.nodes[0]!.properties.language, "csharp");
    assert.deepEqual(json(block.nodes[0]!.properties.csharpNamespaces), ["A.B", "A.B.C"]);
    assert.equal(named(block, "Class", "A.B.C.X").properties.namespace, "A.B.C");
    assert.equal(named(block, "Class", "A.B.Y").properties.namespace, "A.B");
    assert.equal(named(block, "Class", "Z").properties.namespace, "");

    const scoped = await parse("Scoped.cs", `using System;\nnamespace Acme.Shop;\npublic class Cart {}\ninterface IPay {}`);
    assert.deepEqual(json(scoped.nodes[0]!.properties.csharpNamespaces), ["Acme.Shop"]);
    assert.equal(named(scoped, "Class", "Acme.Shop.Cart").properties.namespace, "Acme.Shop");
    assert.equal(named(scoped, "Interface", "Acme.Shop.IPay").properties.namespace, "Acme.Shop");
    // The using before the file-scoped namespace is in the compilation unit's scope.
    assert.equal(byLabel(scoped, "Import")[0]!.properties.usingScope, "");
  });

  it("emits using, using static, alias and global using as Import nodes with their kind", async () => {
    const parsed = await parse("Usings.cs", `global using System;
using System.Collections.Generic;
using static System.Math;
using Json = System.Text.Json.JsonSerializer;
using Lst = System.Collections.Generic.List<int>;
namespace App {
  using App.Models;
  class C {}
}`);
    const imports = byLabel(parsed, "Import");
    assert.equal(imports.length, 6);
    const by = (source: string, kind: string) => imports.find((node) => node.properties.source === source && node.properties.importKind === kind)!;
    assert.deepEqual(
      { kind: by("System", "normal").properties.importKind, global: by("System", "normal").properties.isGlobal, scope: by("System", "normal").properties.usingScope },
      { kind: "normal", global: true, scope: "" },
    );
    assert.equal(by("System.Collections.Generic", "normal").properties.isGlobal, false);
    assert.equal(by("System.Math", "static").properties.isStatic, true);
    assert.equal(by("System.Text.Json.JsonSerializer", "alias").properties.alias, "Json");
    assert.equal(by("System.Collections.Generic.List", "alias").properties.alias, "Lst");
    assert.equal(by("System.Collections.Generic.List", "alias").properties.specifier, "using Lst = System.Collections.Generic.List<int>;");
    assert.equal(by("App.Models", "normal").properties.usingScope, "App");
    assert.equal(related(parsed, "IMPORTS", parsed.nodes[0]!).length, 6);
  });

  it("keeps the rest of the file and warns when a statement has a syntax error", async () => {
    const parsed = await parse("Broken.cs", `class Good { void A() {} }\nclass Bad { void B() { int x = ; } }\nclass Also { }`);
    assert.ok(parsed.warnings?.[0]?.startsWith("Syntax error: left out"), String(parsed.warnings));
    assert.ok(parsed.nodes.some((node) => node.label === "Class" && node.properties.name === "Good"));
    assert.ok(parsed.nodes.some((node) => node.label === "Class" && node.properties.name === "Also"));
  });
});

describe("C# parser: declarations", () => {
  const SAMPLE = `namespace Acme;
[Serializable, Obsolete("old")]
public abstract class Repo<T, K> : Base<T>, IRepo<T>, IDisposable where T : class, new() where K : struct
{
  public class Inner { public int V; }
  private readonly List<string> names = new List<string>();
  public static int Counter = 1, Other;
  public const int Max = 10;
  public Repo(int x, string y = "a") : base(x) { Setup(); }
  public virtual void Run() { }
  public override string ToString() => "r";
  protected internal abstract Task<int> Load(params int[] ids);
  private protected static void Helper(ref int a, out int b, in int c) { b = 0; }
  public string Name { get; private set; }
  public int Size => names.Count;
  public int this[int i, string key] { get => i; set { Store(i); } }
  public event EventHandler Changed;
  public event EventHandler<int> Raised { add { Hook(); } remove { } }
  [field: NonSerialized] public int Hidden { get; init; }
  string IRepo<T>.Id => "x";
  void IDisposable.Dispose() { }
}
public struct Point { public int X, Y; }
public readonly record struct Pair(int A, string B);
public record Person(string First, string Last) : Entity;
public enum Color : byte { Red, Green = 2 }
public delegate TResult Map<in T, out TResult>(T input) where T : class;
internal interface IRepo<T> : IDisposable { void Save(T item); string Id { get; } event EventHandler Done; static void Make() { } }
static partial class Ext { }
`;

  it("emits classes, structs, records, enums, delegates and interfaces with kind, namespace and visibility", async () => {
    const parsed = await parse("Decls.cs", SAMPLE);
    const repo = named(parsed, "Class", "Acme.Repo");
    assert.deepEqual(
      { kind: repo.properties.kind, visibility: repo.properties.visibility, abstract: repo.properties.isAbstract, exported: repo.properties.isExported, nesting: repo.properties.nesting, arity: repo.properties.arity },
      { kind: "class", visibility: "public", abstract: true, exported: true, nesting: "top-level", arity: 2 },
    );
    assert.deepEqual(json(repo.properties.typeParameters), ["T", "K"]);
    assert.deepEqual(json(repo.properties.constraints), [{ param: "T", constraints: ["class", "new()"] }, { param: "K", constraints: ["struct"] }]);
    assert.equal(named(parsed, "Class", "Acme.Point").properties.kind, "struct");
    assert.equal(named(parsed, "Class", "Acme.Pair").properties.kind, "record struct");
    assert.equal(named(parsed, "Class", "Acme.Person").properties.kind, "record");
    assert.equal(named(parsed, "Class", "Acme.Color").properties.kind, "enum");
    const map = named(parsed, "Class", "Acme.Map");
    assert.equal(map.properties.kind, "delegate");
    assert.equal(map.properties.returnType, "TResult");
    assert.deepEqual(json(map.properties.parameters), [{ name: "input", type: "T" }]);
    assert.deepEqual(json(map.properties.typeParameters), ["T", "TResult"]);
    assert.deepEqual(json(map.properties.constraints), [{ param: "T", constraints: ["class"] }]);
    const repoInterface = named(parsed, "Interface", "Acme.IRepo");
    assert.equal(repoInterface.properties.visibility, "internal");
    assert.equal(repoInterface.properties.isExported, true);
    assert.equal(named(parsed, "Class", "Acme.Ext").properties.isStatic, true);
    // Every type, nested ones included, is defined by the file (as in Java).
    const file = parsed.nodes[0]!;
    assert.equal(related(parsed, "DEFINES_CLASS", file).length, 8);
    assert.equal(related(parsed, "DEFINES_INTERFACE", file).length, 1);
  });

  it("nests types and keeps the outer type", async () => {
    const parsed = await parse("Nested.cs", SAMPLE);
    const inner = named(parsed, "Class", "Acme.Repo.Inner");
    assert.equal(inner.properties.nesting, "nested");
    assert.equal(inner.properties.outer, "Acme.Repo");
    assert.equal(inner.properties.visibility, "public");
    assert.equal(inner.properties.namespace, "Acme");
    assert.equal(inner.properties.isExported, true);
    const nested = await parse("Nested2.cs", `class A { class Hidden { } protected class Prot { } }`);
    assert.equal(named(nested, "Class", "A.Hidden").properties.visibility, "private");
    assert.equal(named(nested, "Class", "A.Hidden").properties.isExported, false);
    assert.equal(named(nested, "Class", "A.Prot").properties.visibility, "protected");
  });

  it("records the raw base list in order with the relation each position can have", async () => {
    const parsed = await parse("Bases.cs", SAMPLE);
    const repo = named(parsed, "Class", "Acme.Repo");
    assert.deepEqual(json(repo.properties.baseNames), ["Base", "IRepo", "IDisposable"]);
    assert.deepEqual(json(repo.properties.bases), [
      { name: "Base", text: "Base<T>", relation: "base" },
      { name: "IRepo", text: "IRepo<T>", relation: "interface" },
      { name: "IDisposable", text: "IDisposable", relation: "interface" },
    ]);
    assert.deepEqual(json(named(parsed, "Class", "Acme.Person").properties.baseNames), ["Entity"]);
    assert.deepEqual(json(named(parsed, "Class", "Acme.Color").properties.bases), [{ name: "byte", text: "byte", relation: "underlying" }]);
    assert.deepEqual(json(named(parsed, "Interface", "Acme.IRepo").properties.bases), [{ name: "IDisposable", text: "IDisposable", relation: "interface" }]);
    assert.deepEqual(json(named(parsed, "Interface", "Acme.IRepo").properties.embeds), ["IDisposable"]);
    const struct = await parse("StructBases.cs", `struct S : IFoo, IBar {}`);
    assert.deepEqual(json(named(struct, "Class", "S").properties.bases), [
      { name: "IFoo", text: "IFoo", relation: "interface" },
      { name: "IBar", text: "IBar", relation: "interface" },
    ]);
  });

  it("emits methods and constructors with flags, parameter counts and return types", async () => {
    const parsed = await parse("Members.cs", SAMPLE);
    const run = named(parsed, "Function", "Acme.Repo.Run");
    assert.deepEqual(
      { v: run.properties.visibility, virtual: run.properties.isVirtual, override: run.properties.isOverride, count: run.properties.parameterCount, ret: run.properties.returnType, kind: run.properties.kind },
      { v: "public", virtual: true, override: false, count: 0, ret: "void", kind: "method" },
    );
    const toString = named(parsed, "Function", "Acme.Repo.ToString");
    assert.equal(toString.properties.isOverride, true);
    const load = named(parsed, "Function", "Acme.Repo.Load");
    assert.equal(load.properties.visibility, "protected internal");
    assert.equal(load.properties.isAbstract, true);
    assert.equal(load.properties.hasParams, true);
    assert.equal(load.properties.parameterCount, 1);
    assert.equal(load.properties.requiredParameterCount, 0);
    assert.equal(load.properties.returnType, "Task<int>");
    assert.deepEqual(json(load.properties.parameters), [{ name: "ids", type: "int[]", params: true }]);
    const helper = named(parsed, "Function", "Acme.Repo.Helper");
    assert.equal(helper.properties.visibility, "private protected");
    assert.equal(helper.properties.isStatic, true);
    assert.deepEqual((json(helper.properties.parameters) as Array<{ modifier: string }>).map((parameter) => parameter.modifier), ["ref", "out", "in"]);
    const ctor = named(parsed, "Function", "Acme.Repo.Repo");
    assert.equal(ctor.properties.kind, "constructor");
    assert.equal(ctor.properties.parameterCount, 2);
    assert.equal(ctor.properties.requiredParameterCount, 1);
    assert.deepEqual(json(ctor.properties.parameters), [{ name: "x", type: "int" }, { name: "y", type: "string", optional: true, defaultValue: "\"a\"" }]);
    assert.deepEqual(json(named(parsed, "Function", "Acme.Repo.Run").properties.parameters), []);
    const defaults = await parse("Defaults.cs", `class A { void Priv() {} public class B { void M() {} } interface I { void X(); } }`);
    assert.equal(named(defaults, "Function", "A.Priv").properties.visibility, "private");
    assert.equal(named(defaults, "Function", "A.Priv").properties.isExported, false);
    assert.equal(named(defaults, "Function", "A.I.X").properties.visibility, "public");
    assert.equal(named(defaults, "Function", "A.I.X").properties.isAbstract, true);
    assert.equal(named(defaults, "Function", "A.B.M").properties.visibility, "private");
  });

  it("flags extension methods with their receiver type and counts the receiver as a parameter", async () => {
    const parsed = await parse("Ext.cs", `static class StringExt {
  public static string Shout(this string s, int times = 1) => s;
  public static void NotExt(string s) { }
  public static T Pick<T>(this IEnumerable<T> items, params int[] i) => default;
}`);
    const shout = named(parsed, "Function", "StringExt.Shout");
    assert.equal(shout.properties.isExtension, true);
    assert.equal(shout.properties.extensionReceiver, "string");
    assert.equal(shout.properties.parameterCount, 2);
    assert.equal(shout.properties.requiredParameterCount, 1);
    assert.deepEqual((json(shout.properties.parameters) as Array<{ modifier?: string }>)[0]!.modifier, "this");
    assert.equal(named(parsed, "Function", "StringExt.NotExt").properties.isExtension, undefined);
    const pick = named(parsed, "Function", "StringExt.Pick");
    assert.equal(pick.properties.extensionReceiver, "IEnumerable");
    assert.equal(pick.properties.hasParams, true);
    assert.deepEqual(json(pick.properties.typeParameters), ["T"]);
  });

  it("emits fields, properties, indexers, events, enum members and record components", async () => {
    const parsed = await parse("Fields.cs", SAMPLE);
    const names = field(parsed, "names");
    assert.deepEqual(
      { kind: names.properties.fieldKind, type: names.properties.typeName, declared: names.properties.declaredType, readonly: names.properties.isReadonly, v: names.properties.visibility },
      { kind: "field", type: "List", declared: "List<string>", readonly: true, v: "private" },
    );
    assert.equal(field(parsed, "Counter").properties.isStatic, true);
    assert.equal(field(parsed, "Other").properties.isStatic, true);
    const max = field(parsed, "Max");
    assert.deepEqual({ kind: max.properties.fieldKind, isStatic: max.properties.isStatic, isReadonly: max.properties.isReadonly }, { kind: "constant", isStatic: true, isReadonly: true });
    const name = field(parsed, "Name");
    assert.deepEqual({ kind: name.properties.fieldKind, accessors: name.properties.accessors, type: name.properties.typeName, v: name.properties.visibility }, { kind: "property", accessors: "get,set", type: "string", v: "public" });
    assert.equal(field(parsed, "Size").properties.accessors, "get");
    assert.equal(field(parsed, "Size").properties.isReadonly, true);
    const indexer = field(parsed, "this[]");
    assert.equal(indexer.properties.fieldKind, "indexer");
    assert.deepEqual(json(indexer.properties.parameters), [{ name: "i", type: "int" }, { name: "key", type: "string" }]);
    assert.equal(field(parsed, "Changed").properties.fieldKind, "event");
    assert.equal(field(parsed, "Raised").properties.fieldKind, "event");
    const explicitProperty = field(parsed, "Id");
    assert.equal(explicitProperty.properties.explicitInterface, "IRepo");
    // Accessors with a body are functions of their own; auto-properties have none.
    assert.ok(named(parsed, "Function", "Acme.Repo.get_Size"));
    assert.ok(named(parsed, "Function", "Acme.Repo.set_Item"));
    assert.equal(named(parsed, "Function", "Acme.Repo.get_Item").properties.parameterCount, 2);
    assert.equal(named(parsed, "Function", "Acme.Repo.add_Raised").properties.methodKind, "event-add");
    assert.equal(parsed.nodes.some((node) => node.label === "Function" && node.properties.name === "get_Name"), false);
    assert.equal(named(parsed, "Function", "Acme.Repo.Dispose").properties.explicitInterface, "IDisposable");
    assert.equal(named(parsed, "Function", "Acme.Repo.Dispose").properties.visibility, "private");
    // Enum members, record components, primary constructors.
    const red = field(parsed, "Red");
    assert.deepEqual({ kind: red.properties.fieldKind, type: red.properties.typeName }, { kind: "enum-constant", type: "Acme.Color" });
    assert.equal(field(parsed, "First").properties.fieldKind, "record-component");
    assert.deepEqual(json(named(parsed, "Class", "Acme.Person").properties.primaryParameters), [{ name: "First", type: "string" }, { name: "Last", type: "string" }]);
    const personCtor = parsed.nodes.find((node) => node.label === "Function" && node.properties.qualifiedName === "Acme.Person.Person");
    assert.equal(personCtor?.properties.methodKind, "primary");
    assert.equal(personCtor?.properties.parameterCount, 2);
    // Interface members hang off the interface.
    const repoInterface = named(parsed, "Interface", "Acme.IRepo");
    assert.deepEqual(json(repoInterface.properties.methods), ["Save", "Make"]);
    assert.equal(related(parsed, "DEFINES_INTERFACE_METHOD", repoInterface).length, 2);
    assert.equal(related(parsed, "DEFINES_INTERFACE_FIELD", repoInterface).length, 2);
    assert.equal(named(parsed, "Function", "Acme.IRepo.Make").properties.isAbstract, false);
    assert.equal(named(parsed, "Function", "Acme.IRepo.Save").properties.isAbstract, true);
  });

  it("emits attributes as Decorator nodes with their arguments on types, members, fields and parameters", async () => {
    const parsed = await parse("Attributes.cs", `using Xunit;
[ApiController, Route("api/[controller]")]
public class Ctl {
  [Fact] public void A() {}
  [Theory, InlineData(1, "x"), InlineData(Name = "n", Other: 3)]
  public void B([FromBody] Dto d, int plain) {}
  [Required] [MaxLength(5)] public string Prop { get; set; }
  [NonSerialized] private int f;
  [field: JsonIgnore] public int Auto { get; set; }
  [return: NotNull] public string R() => "";
}`);
    const ctl = named(parsed, "Class", "Ctl");
    const classDecorators = related(parsed, "HAS_DECORATOR", ctl);
    assert.deepEqual(classDecorators.map((node) => node.properties.name), ["ApiController", "Route"]);
    assert.deepEqual(json(classDecorators[1]!.properties.args), ["\"api/[controller]\""]);
    assert.deepEqual(related(parsed, "HAS_METHOD_DECORATOR", named(parsed, "Function", "Ctl.A")).map((node) => node.properties.name), ["Fact"]);
    const theory = related(parsed, "HAS_METHOD_DECORATOR", named(parsed, "Function", "Ctl.B"));
    assert.deepEqual(theory.map((node) => node.properties.name), ["Theory", "InlineData", "InlineData"]);
    assert.deepEqual(json(theory[1]!.properties.args), ["1", "\"x\""]);
    assert.deepEqual(json(theory[2]!.properties.args), ["Name=\"n\"", "Other=3"]);
    assert.deepEqual(related(parsed, "FIELD_HAS_DECORATOR", field(parsed, "Prop")).map((node) => node.properties.name), ["Required", "MaxLength"]);
    assert.deepEqual(related(parsed, "FIELD_HAS_DECORATOR", field(parsed, "f")).map((node) => node.properties.name), ["NonSerialized"]);
    assert.equal(related(parsed, "FIELD_HAS_DECORATOR", field(parsed, "Auto"))[0]!.properties.attributeTarget, "field");
    assert.equal(related(parsed, "HAS_METHOD_DECORATOR", named(parsed, "Function", "Ctl.R"))[0]!.properties.attributeTarget, "return");
    // Parameter attributes travel in the parameter record, as Java annotations do.
    assert.deepEqual(json(named(parsed, "Function", "Ctl.B").properties.parameters), [
      { name: "d", type: "Dto", annotations: [{ name: "FromBody", args: [] }] },
      { name: "plain", type: "int" },
    ]);
    const ids = parsed.nodes.map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("C# parser: partial types", () => {
  const A = `namespace Shop;\n[Serializable] public partial class Order : IOrder { public void Place() {} }`;
  const B = `namespace Shop;\n public partial class Order : Base, IAudit { private int total; public void Ship() {} }`;

  it("gives every declaration of a partial type the same id, keyed by the namespace-qualified name", async () => {
    const first = await parse("Order.cs", A);
    const second = await parse("Order.Parts.cs", B);
    const one = named(first, "Class", "Shop.Order");
    const two = named(second, "Class", "Shop.Order");
    assert.equal(one.id, "csharp:partial:Shop.Order");
    assert.equal(two.id, one.id);
    assert.equal(one.properties.isPartial, true);
    assert.equal(one.properties.partialKey, "Shop.Order");
    // Each file links the shared node; members stay file-keyed and hang off it.
    assert.equal(related(first, "DEFINES_CLASS", first.nodes[0]!)[0]!.id, one.id);
    assert.equal(related(second, "DEFINES_CLASS", second.nodes[0]!)[0]!.id, one.id);
    const place = named(first, "Function", "Shop.Order.Place");
    const ship = named(second, "Function", "Shop.Order.Ship");
    assert.notEqual(place.id, ship.id);
    assert.ok(place.id.startsWith("file:Order.cs:"));
    assert.deepEqual(related(second, "DEFINES_METHOD", two).map((node) => node.id), [ship.id]);
    // Decorator ids carry the file, so two declarations never collide.
    assert.ok(related(first, "HAS_DECORATOR", one)[0]!.id.startsWith("file:Order.cs:"));
  });

  it("keeps each declaration's own facts on its File node", async () => {
    const second = await parse("Order2.cs", B);
    const facts = json(second.nodes[0]!.properties.csharpPartials) as Array<Record<string, unknown>>;
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.id, "csharp:partial:Shop.Order");
    assert.deepEqual((facts[0]!.bases as Array<{ name: string }>).map((base) => base.name), ["Base", "IAudit"]);
    assert.deepEqual(facts[0]!.methods, ["Ship"]);
    assert.deepEqual((facts[0]!.fields as Array<{ name: string }>).map((entry) => entry.name), ["total"]);
  });

  it("separates generic arities and nested partials; a plain type is file-keyed", async () => {
    const parsed = await parse("Generic.cs", `partial class Box<T> { partial class Inner {} }\npartial class Box<T, U> {}\nclass Plain {}`);
    assert.ok(parsed.nodes.some((node) => node.id === "csharp:partial:Box`1"));
    assert.ok(parsed.nodes.some((node) => node.id === "csharp:partial:Box`2"));
    assert.ok(parsed.nodes.some((node) => node.id === "csharp:partial:Box`1.Inner"));
    assert.ok(named(parsed, "Class", "Plain").id.startsWith("file:Generic.cs:class:"));
    assert.equal(named(parsed, "Class", "Plain").properties.partialKey, undefined);
  });
});

describe("C# parser: calls and locals", () => {
  const SOURCE = `using System;
namespace App;
public class Svc {
  private Repo repo;
  public Helper Help { get; }
  public void Run(Repo given, string[] list)
  {
    var made = new Repo(1, "x");
    Widget w = new();
    var cast = (Widget)other;
    var maybe = other as Gadget;
    Repo typed = given;
    var unknown = Compute();
    made.Save(typed);
    this.repo.Load(1);
    repo.Load(2);
    Help.Go();
    this.Helper2();
    base.Init(2, 3);
    Util.Format("a", 1, 2L, true);
    System.Console.WriteLine(list);
    string.Join(",", list);
    new Builder().Build(1);
    ((Widget)other).Show();
    maybe?.Close();
    unknown.Do();
    Func<int> f = () => Make<int>();
    foreach (var item in list) item.Trim();
    using var res = new Res();
    if (other is Dog pet) pet.Bark();
    int.TryParse("1", out var n);
    Local(1);
    int Local(int a) => a;
  }
  public Svc(int a) : this(a, 0) { }
  public Svc(int a, int b) : base() { }
}
class Other { static readonly Cache C = new(); Repo R = new() { A = 1 }; int V = Calc(); }`;

  it("records call sites with the shape of their receiver", async () => {
    const parsed = await parse("Calls.cs", SOURCE);
    const run = named(parsed, "Function", "App.Svc.Run");
    const mine = related(parsed, "CALLS", run);
    assert.ok(mine.length > 15);
    const one = (expression: string): GraphNode => {
      const found = mine.filter((node) => node.properties.expression === expression);
      assert.equal(found.length, 1, expression);
      return found[0]!;
    };
    const props = (expression: string) => one(expression).properties;

    assert.deepEqual(
      { kind: props("made.Save").callKind, callee: props("made.Save").callee, receiver: props("made.Save").receiver, rk: props("made.Save").receiverKind, local: props("made.Save").receiverIsLocal, type: props("made.Save").receiverType, argc: props("made.Save").argumentCount, types: props("made.Save").argumentTypes },
      { kind: "method", callee: "Save", receiver: "made", rk: "identifier", local: true, type: "Repo", argc: 1, types: "[\"Repo\"]" },
    );
    assert.equal(props("this.repo.Load").receiverKind, "this-member");
    assert.equal(props("repo.Load").receiverKind, "identifier");
    assert.equal(props("repo.Load").qualifier, "repo");
    assert.equal(props("repo.Load").receiverIsLocal, undefined);
    assert.equal(props("Help.Go").qualifier, "Help");
    assert.equal(props("this.Helper2").receiverKind, "this");
    assert.equal(props("this.Helper2").qualifier, undefined);
    assert.deepEqual({ rk: props("base.Init").receiverKind, argc: props("base.Init").argumentCount }, { rk: "base", argc: 2 });
    assert.deepEqual(
      { q: props("Util.Format").qualifier, rk: props("Util.Format").receiverKind, types: props("Util.Format").argumentTypes },
      { q: "Util", rk: "identifier", types: "[\"string\",\"int\",\"long\",\"bool\"]" },
    );
    assert.deepEqual({ q: props("System.Console.WriteLine").qualifier, rk: props("System.Console.WriteLine").receiverKind, types: props("System.Console.WriteLine").argumentTypes }, { q: "System.Console", rk: "member", types: "[\"string[]\"]" });
    assert.deepEqual({ q: props("string.Join").qualifier, rk: props("string.Join").receiverKind }, { q: "string", rk: "type" });
    assert.deepEqual({ rk: props("new Builder().Build").receiverKind, ctor: props("new Builder().Build").receiverConstructor }, { rk: "new", ctor: "Builder" });
    assert.deepEqual({ rk: props("((Widget)other).Show").receiverKind, type: props("((Widget)other).Show").receiverType }, { rk: "cast", type: "Widget" });
    assert.deepEqual({ cond: props("maybe?.Close").isConditional, type: props("maybe?.Close").receiverType, local: props("maybe?.Close").receiverIsLocal }, { cond: true, type: "Gadget", local: true });
    // `var unknown = Compute()` has no known type.
    assert.equal(props("unknown.Do").receiverIsLocal, true);
    assert.equal(props("unknown.Do").receiverType, undefined);
    assert.equal(props("Compute").receiver, null);
    assert.equal(props("Local").argumentCount, 1);
    assert.equal(props("Make").typeArguments, "int");
    assert.equal(props("pet.Bark").receiverType, "Dog");
    assert.equal(props("item.Trim").receiverIsLocal, true);

    // Constructors: explicit, target-typed (the declared type is certain) and with arguments.
    assert.deepEqual({ kind: props("new Repo").callKind, argc: props("new Repo").argumentCount, types: props("new Repo").argumentTypes }, { kind: "constructor", argc: 2, types: "[\"int\",\"string\"]" });
    const widgetNew = mine.filter((node) => node.properties.expression === "new Widget");
    assert.equal(widgetNew.length, 1);
    assert.equal(widgetNew[0]!.properties.receiverKind, "implicit-new");
    assert.equal(widgetNew[0]!.properties.callee, "Widget");
  });

  it("reads local types from declarations, var with new/cast/as, patterns and parameters", async () => {
    const parsed = await parse("Locals.cs", SOURCE);
    const locals = json(named(parsed, "Function", "App.Svc.Run").properties.csharpLocals) as Record<string, { type?: string } | null>;
    assert.deepEqual(locals.given, { type: "Repo" });
    assert.deepEqual(locals.list, { type: "string[]" });
    assert.deepEqual(locals.made, { type: "Repo" });
    assert.deepEqual(locals.w, { type: "Widget" });
    assert.deepEqual(locals.cast, { type: "Widget" });
    assert.deepEqual(locals.maybe, { type: "Gadget" });
    assert.deepEqual(locals.typed, { type: "Repo" });
    assert.equal(locals.unknown, null);
    assert.deepEqual(locals.pet, { type: "Dog" });
    assert.deepEqual(locals.res, { type: "Res" });
    assert.equal(locals.n, null);
    assert.equal(locals.item, null);
  });

  it("emits explicit constructor calls and calls inside field initializers", async () => {
    const parsed = await parse("Init.cs", SOURCE);
    const ctor = parsed.nodes.find((node) => node.label === "Function" && node.properties.qualifiedName === "App.Svc.Svc" && node.properties.parameterCount === 1)!;
    const explicit = related(parsed, "CALLS", ctor);
    assert.deepEqual(explicit.map((node) => [node.properties.callKind, node.properties.callee, node.properties.argumentCount]), [["explicitConstructor", "this", 2]]);
    const clinit = named(parsed, "Function", "App.Other.<clinit>");
    assert.deepEqual(related(parsed, "CALLS", clinit).map((node) => node.properties.expression), ["new Cache"]);
    assert.equal(related(parsed, "CALLS", clinit)[0]!.properties.receiverKind, "implicit-new");
    const initBlock = named(parsed, "Function", "App.Other.<init-block>");
    assert.deepEqual(related(parsed, "CALLS", initBlock).map((node) => node.properties.expression).sort(), ["Calc", "new Repo"]);
  });

  it("marks top-level statements on the file and gives them a synthetic function", async () => {
    const parsed = await parse("Program.cs", `using System;\nvar app = Build();\napp.Run();\nint Twice(int x) => x * 2;\nclass Util { public static void Main(string[] args) { } }`);
    const file = parsed.nodes[0]!;
    assert.equal(file.properties.hasTopLevelStatements, true);
    const top = named(parsed, "Function", "<top-level>");
    assert.equal(top.properties.kind, "top-level");
    assert.deepEqual(related(parsed, "DEFINES_FUNCTION", file).map((node) => node.id), [top.id]);
    assert.deepEqual(related(parsed, "CALLS", top).map((node) => node.properties.expression), ["Build", "app.Run"]);
    const main = named(parsed, "Function", "Util.Main");
    assert.deepEqual({ s: main.properties.isStatic, n: main.properties.parameterCount, v: main.properties.visibility }, { s: true, n: 1, v: "public" });
    const plain = await parse("NoTop.cs", `class A {}`);
    assert.equal(plain.nodes[0]!.properties.hasTopLevelStatements, undefined);
  });

  it("walks a very long expression chain without recursion", async () => {
    const chain = Array.from({ length: 4000 }, (_, i) => `v${i}`).join(" + ");
    const parsed = await parse("Deep.cs", `class A { int M() { return ${chain}; } void N() { Q(); } }`);
    assert.ok(parsed.nodes.some((node) => node.label === "Function" && node.properties.name === "M"));
    assert.equal(calls(parsed, "Q").length, 1);
  });
});

describe("C# partial types in a scan", () => {
  it("merges the declarations of a partial type into one Class node linked from every file", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-scan-"));
    try {
      await writeFile(path.join(project, "Order.cs"), `namespace Shop;\npublic partial class Order { public void Place() { Ship(); } }`);
      await writeFile(path.join(project, "Order.Parts.cs"), `namespace Shop;\npublic partial class Order { public void Ship() { } }`);
      await writeFile(path.join(project, "Other.cs"), `namespace Shop;\npublic class Other { }`);
      const result = await buildCodeGraph(project, { continueOnError: true, concurrency: 2 });
      const orders = result.nodes.filter((node) => node.label === "Class" && node.properties.qualifiedName === "Shop.Order");
      assert.equal(orders.length, 1);
      const defines = result.relationships.filter((relationship) => relationship.type === "DEFINES_CLASS" && relationship.to === orders[0]!.id).map((relationship) => relationship.from).sort();
      assert.deepEqual(defines, ["file:Order.Parts.cs", "file:Order.cs"]);
      const methods = result.relationships.filter((relationship) => relationship.type === "DEFINES_METHOD" && relationship.from === orders[0]!.id);
      assert.equal(methods.length, 2);
      assert.equal(result.nodes.filter((node) => node.label === "File" && node.properties.language === "csharp").length, 3);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
