import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { createCSharpParser, type CSharpParsePlugin } from "../src/integrations/languages/csharp/parser.js";
import {
  arrayElements,
  attributeValue,
  csharpAttributeReader,
  csharpStringLiteral,
  findAttributes,
  namedArgument,
  positionalArguments,
  typeofArgument,
} from "../src/integrations/frameworks/csharp/attributes.js";
import { invocationChain, invocationInfo, lambdaInfo } from "../src/integrations/frameworks/csharp/invocations.js";
import { csharpTypeResolver } from "../src/integrations/frameworks/csharp/type-names.js";
import { joinRoutePath } from "../src/integrations/frameworks/csharp/emit.js";
import { csharpFrameworkParser } from "../src/integrations/frameworks/csharp/index.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { IGraphContributor } from "../src/core/contracts/graph-contributor.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-foundation-"));
  await mkdir(path.join(root, "Controllers"), { recursive: true });
  await writeFile(
    path.join(root, "Controllers/UsersController.cs"),
    `using Microsoft.AspNetCore.Mvc;
using App.Services;

namespace App.Controllers;

[ApiController]
[Route("api/[controller]")]
public class UsersController(IUserService users) : ControllerBase
{
    [HttpGet("{id:int}", Name = "GetUser")]
    public IActionResult Get(int id, [FromServices] IUserService svc) => Ok();

    [HttpPostAttribute]
    public IActionResult Post() => Ok();
}
`,
  );
  await writeFile(
    path.join(root, "Services.cs"),
    `namespace App.Services;
public interface IUserService { }
public class UserService : IUserService { }
`,
  );
  await writeFile(
    path.join(root, "Program.cs"),
    `using App.Services;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IUserService, UserService>();
var app = builder.Build();
app.MapGroup("/api").MapGet("/x/{id}", (int id, [FromServices] IUserService foo) => Results.Ok()).WithName("a");
app.MapPut("/z", Handlers.Put);
app.Run();
`,
  );
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("C# framework foundation (Phase 46 wave 0)", () => {
  it("runs parse plugins with functions, types and calls, and versions the cache fingerprint", async () => {
    let seen: Parameters<CSharpParsePlugin>[0] | undefined;
    const plugin = Object.assign(
      (file: Parameters<CSharpParsePlugin>[0]) => {
        if (file.fileNodeId.endsWith("Program.cs")) {
          seen = { ...file, functions: [...file.functions], types: [...file.types], calls: [...file.calls] };
          const chain = file.calls.map((call) => invocationInfo(call.syntax)).find((info) => info?.name === "MapGet")!;
          assert.equal(chain.arguments[0]!.value, "/x/{id}");
          assert.equal(chain.arguments[1]!.kind, "lambda");
          const lambda = lambdaInfo(chain.arguments[1]!.node)!;
          assert.deepEqual(lambda.parameters.map((p) => `${p.type} ${p.name}`), ["int id", "IUserService foo"]);
          assert.equal(lambda.parameters[1]!.annotations?.[0]?.name, "FromServices");
          const outer = file.calls.find((call) => call.syntax.text.endsWith('.WithName("a")'))!;
          assert.deepEqual(invocationChain(outer.syntax).chain.map((info) => info.name), ["MapGroup", "MapGet", "WithName"]);
          const add = file.calls.map((call) => invocationInfo(call.syntax)).find((info) => info?.name === "AddScoped")!;
          assert.deepEqual(add.typeArguments, ["IUserService", "UserService"]);
          const put = file.calls.map((call) => invocationInfo(call.syntax)).find((info) => info?.name === "MapPut")!;
          assert.equal(put.arguments[1]!.kind, "method-group");
        }
      },
      { version: "test" },
    );
    const parser = createCSharpParser([plugin]);
    assert.equal(parser.version, "1+test");
    assert.equal(createCSharpParser().version, "1");
    assert.match(csharpFrameworkParser.version ?? "", /^1(?:\+[\w.+-]+)?$/u, "plugins that output set a version: it joins the parse cache fingerprint");
    await parser.parse(root, path.join(root, "Program.cs"));
    assert.ok(seen);
    assert.ok(seen.functions.some((fn) => fn.node.properties.name === "<top-level>"));
    const controller = await parser.parse(root, path.join(root, "Controllers/UsersController.cs"));
    assert.ok(controller.nodes.some((node) => node.label === "Class"));
  });

  it("reads attributes with the namespace rule and resolves types", async () => {
    const graph = await buildCodeGraph(root, { continueOnError: false });
    const view = graphView(graph);
    const reader = csharpAttributeReader(view);
    const controller = view.nodesWithLabel("Class").find((node) => node.properties.name === "UsersController")!;
    const classAttributes = reader.attributesOf(controller);
    assert.deepEqual(classAttributes.map((a) => a.simpleName), ["ApiController", "Route"]);
    assert.equal(findAttributes(classAttributes, "Route", ["Microsoft.AspNetCore.Mvc"]).length, 1);
    assert.equal(findAttributes(classAttributes, "Route", ["Grpc"]).length, 0, "a using of another known framework rejects it");
    const methods = view.nodesWithLabel("Function").filter((node) => node.properties.className === "UsersController");
    const get = methods.find((node) => node.properties.name === "Get")!;
    const [httpGet] = findAttributes(reader.attributesOf(get), "HttpGet", ["Microsoft.AspNetCore.Mvc"]);
    assert.deepEqual(positionalArguments(httpGet!), ['"{id:int}"']);
    assert.equal(attributeValue(namedArgument(httpGet!, "Name"))?.value, "GetUser");
    const post = methods.find((node) => node.properties.name === "Post")!;
    assert.equal(findAttributes(reader.attributesOf(post), "HttpPost", ["Microsoft.AspNetCore.Mvc"]).length, 1, "XAttribute suffix");
    const resolver = csharpTypeResolver(view);
    const type = resolver.typeOf(controller)!;
    assert.ok(resolver.derivesFromExternal(type, ["ControllerBase", "Controller"]));
    const service = resolver.resolve("IUserService", get);
    assert.equal(service?.qualifiedName, "App.Services.IUserService");
    assert.equal(resolver.methodsOf(type).length >= 3, true, "methods plus the primary constructor");
  });

  it("reads string and argument shapes", () => {
    assert.equal(csharpStringLiteral('"a" + "b"'), "ab");
    assert.equal(csharpStringLiteral('@"c:\\x""y"'), 'c:\\x"y');
    assert.equal(csharpStringLiteral('"""raw"""'), "raw");
    assert.equal(csharpStringLiteral('$"a{b}"'), null);
    assert.equal(csharpStringLiteral("Const.Path"), null);
    assert.equal(typeofArgument("typeof(Foo<int>)"), "Foo<int>");
    assert.deepEqual(arrayElements('new[] { "a", "b" }'), ['"a"', '"b"']);
    assert.deepEqual(arrayElements('"a"'), ['"a"']);
    assert.equal(joinRoutePath("/api/", "users", "{id}"), "/api/users/{id}");
  });
});

// The scan graph as the contributor view the helpers read.
function graphView(result: Awaited<ReturnType<typeof buildCodeGraph>>): IGraphContributor {
  const graph = new GraphBuilder();
  graph.addNodes(result.nodes);
  graph.addRelationships(result.relationships);
  return graph;
}
