import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { csharpFileOfId } from "../src/integrations/frameworks/csharp/shared.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

const WEB = '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';
const LIB = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';
const lib = (...refs: string[]) =>
  `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup>${refs.map((ref) => `<ProjectReference Include="${ref}"/>`).join("")}</ItemGroup></Project>\n`;

async function scan(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-di-review-"));
  temporary.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return buildCodeGraph(dir, { continueOnError: false });
}

function injections(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "INJECTS")
    .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${byId.get(rel.to)!.properties.name} ${rel.properties.fieldName} ${rel.properties.via}`)
    .sort();
}
const classNamed = (graph: Graph, name: string) => graph.nodes.find((node) => node.label === "Class" && node.properties.name === name)!;

const USINGS = "using Microsoft.Extensions.DependencyInjection;\nusing Microsoft.Extensions.DependencyInjection.Extensions;\nusing Microsoft.AspNetCore.Mvc;\n";

describe("C# DI review fixes", () => {
  it("TryAdd after Add is dropped: no ambiguity, no stereotype", async () => {
    const graph = await scan({
      "App.csproj": WEB,
      "Program.cs": `${USINGS}var b = WebApplication.CreateBuilder(args);
b.Services.AddScoped<IFoo, FooA>();
b.Services.TryAddScoped<IFoo, FooB>();
b.Services.TryAddScoped<IBar, BarA>();
b.Services.AddScoped<Consumer>();
public interface IFoo {} public class FooA : IFoo {} public class FooB : IFoo {}
public interface IBar {} public class BarA : IBar {}
public class Consumer { public Consumer(IFoo foo, IBar bar) {} }`,
    });
    assert.deepEqual(injections(graph), ["Consumer -> BarA bar constructor", "Consumer -> FooA foo constructor"]);
    assert.equal(classNamed(graph, "Consumer").properties.ambiguousInjections, undefined);
    assert.equal(classNamed(graph, "FooB").properties.diStereotype, undefined);
    assert.equal(classNamed(graph, "FooA").properties.diStereotype, "Scoped");
    assert.equal(classNamed(graph, "BarA").properties.diStereotype, "Scoped"); // a lone TryAdd registers
  });

  it("[FromServices] of a method-group handler of a consumer is one edge and one ambiguity count", async () => {
    const graph = await scan({
      "App.csproj": WEB,
      "Program.cs": `${USINGS}var b = WebApplication.CreateBuilder(args);
b.Services.AddScoped<IFoo, FooA>();
b.Services.AddScoped<IFoo, FooB>();
b.Services.AddScoped<IBar, BarA>();
b.Services.AddScoped<Handlers>();
var app = b.Build();
app.MapGet("/y", Handlers.Get);
public interface IFoo {} public class FooA : IFoo {} public class FooB : IFoo {}
public interface IBar {} public class BarA : IBar {}
public class Handlers { public static string Get([FromServices] IFoo foo, [FromServices] IBar bar) => ""; }`,
    });
    assert.deepEqual(injections(graph), ["Handlers -> BarA bar from-services"]);
    assert.equal(classNamed(graph, "Handlers").properties.ambiguousInjections, 1);
  });

  it("handler-parameter ambiguity is counted per route handler, not per enclosing function", async () => {
    const graph = await scan({
      "App.csproj": WEB,
      "Program.cs": `${USINGS}var b = WebApplication.CreateBuilder(args);
b.Services.AddScoped<IBar, Bar>();
b.Services.AddScoped<IBar, Bar2>();
var app = b.Build();
app.MapTodos();
public interface IBar {} public class Bar : IBar {} public class Bar2 : IBar {}
public static class TodoEndpoints {
  public static void MapTodos(this WebApplication app) {
    app.MapGet("/b", (IBar b) => "");
    app.MapGet("/c", (IBar b) => "");
    app.MapGet("/d", (IBar b2) => "");
  }
}`,
    });
    assert.equal(classNamed(graph, "TodoEndpoints").properties.ambiguousInjections, 3);
  });

  it("an overloaded method with the same ambiguous parameter counts once", async () => {
    const graph = await scan({
      "App.csproj": WEB,
      "Program.cs": `${USINGS}var b = WebApplication.CreateBuilder(args);
b.Services.AddScoped<IFoo, FooA>();
b.Services.AddScoped<IFoo, FooB>();
b.Services.AddScoped<Consumer>();
public interface IFoo {} public class FooA : IFoo {} public class FooB : IFoo {}
public class Consumer { public void M([FromServices] IFoo foo) {} public void M([FromServices] IFoo foo, int x) {} }`,
    });
    assert.equal(classNamed(graph, "Consumer").properties.ambiguousInjections, 1);
  });

  it("generic arguments are compared by resolved type, not by bare name", async () => {
    const graph = await scan({
      "App.csproj": WEB,
      "Program.cs": `${USINGS}var b = WebApplication.CreateBuilder(args);
b.Services.AddScoped<IRepo<A.User>, ARepo>();
b.Services.AddScoped<IRepo<B.User>, BRepo>();
b.Services.AddScoped<Consumer>();
namespace A { public class User {} }
namespace B { public class User {} }
public interface IRepo<T> {} public class ARepo : IRepo<A.User> {} public class BRepo : IRepo<B.User> {}
public class Consumer { public Consumer(IRepo<B.User> repo) {} }`,
    });
    assert.deepEqual(injections(graph), ["Consumer -> BRepo repo constructor"]);
    assert.equal(classNamed(graph, "Consumer").properties.ambiguousInjections, undefined);
  });

  it("registrations in test files are ignored", async () => {
    const graph = await scan({
      "src/App.csproj": WEB,
      "src/Program.cs": `${USINGS}using App;
var b = WebApplication.CreateBuilder(args);
b.Services.AddScoped<IFoo, Foo>();
b.Services.AddScoped<Ctrl>();
namespace App { public interface IFoo {} public class Foo : IFoo {} public class Ctrl { public Ctrl(IFoo f) {} } }`,
      "tests/App.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="xunit" Version="2.0"/><ProjectReference Include="../src/App.csproj"/></ItemGroup></Project>\n`,
      "tests/Fakes.cs": `using App; using Microsoft.Extensions.DependencyInjection;
namespace App.Tests { public class FakeFoo : IFoo {}
public class Factory { void Configure(IServiceCollection s) { s.AddScoped<IFoo, FakeFoo>(); } } }`,
    });
    assert.deepEqual(injections(graph), ["Ctrl -> Foo f constructor"]);
    assert.equal(classNamed(graph, "Ctrl").properties.ambiguousInjections, undefined);
    assert.equal(classNamed(graph, "FakeFoo").properties.diStereotype, undefined);
  });

  it("a host composes the registrations of the library it references", async () => {
    const graph = await scan({
      "Lib/Lib.csproj": LIB,
      "Lib/Lib.cs": `namespace Lib { public interface IFoo {} public class LibConsumer { public LibConsumer(IFoo f) {} } }`,
      "Host/Host.csproj": lib("../Lib/Lib.csproj").replace('Sdk="Microsoft.NET.Sdk"', 'Sdk="Microsoft.NET.Sdk.Web"'),
      "Host/Program.cs": `using Lib; using Microsoft.Extensions.DependencyInjection;
namespace Host { public class FooA : IFoo {}
public static class Setup { public static void Run(IServiceCollection s) { s.AddScoped<IFoo, FooA>(); s.AddScoped<LibConsumer>(); } } }`,
    });
    assert.deepEqual(injections(graph), ["LibConsumer -> FooA f constructor"]);
  });

  it("two unrelated hosts registering the same interface do not clash for their own consumers", async () => {
    const graph = await scan({
      "Shared/Shared.csproj": LIB,
      "Shared/Shared.cs": `namespace Shared { public interface IFoo {} }`,
      "HostA/HostA.csproj": lib("../Shared/Shared.csproj"),
      "HostA/A.cs": `using Shared; using Microsoft.Extensions.DependencyInjection;
namespace HostA { public class FooA : IFoo {} public class AConsumer { public AConsumer(IFoo f) {} }
public static class Setup { public static void Run(IServiceCollection s) { s.AddScoped<IFoo, FooA>(); s.AddScoped<AConsumer>(); } } }`,
      "HostB/HostB.csproj": lib("../Shared/Shared.csproj"),
      "HostB/B.cs": `using Shared; using Microsoft.Extensions.DependencyInjection;
namespace HostB { public class FooB : IFoo {} public class BConsumer { public BConsumer(IFoo f) {} }
public static class Setup { public static void Run(IServiceCollection s) { s.AddScoped<IFoo, FooB>(); s.AddScoped<BConsumer>(); } } }`,
    });
    assert.deepEqual(injections(graph), ["AConsumer -> FooA f constructor", "BConsumer -> FooB f constructor"]);
    assert.equal(classNamed(graph, "AConsumer").properties.ambiguousInjections, undefined);
    assert.equal(classNamed(graph, "BConsumer").properties.ambiguousInjections, undefined);
  });

  it("csharpFileOfId is not fooled by a directory named like an id kind", () => {
    assert.equal(csharpFileOfId("file:class1/Foo.cs:class:5:App.Foo"), "file:class1/Foo.cs");
    assert.equal(csharpFileOfId("file:src/call2/function3/X.cs:function:7:App.X.M:call:9:3:Foo"), "file:src/call2/function3/X.cs");
    assert.equal(csharpFileOfId("file:class/Foo.cs:interface:2:I"), "file:class/Foo.cs");
    assert.equal(csharpFileOfId("file:Program.cs:decorator:3:Authorize"), "file:Program.cs");
  });
});
