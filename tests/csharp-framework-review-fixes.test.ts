import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

async function scan(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "csharp-fw-review-"));
  try {
    await writeFile(path.join(dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    const graph = await buildCodeGraph(dir, { continueOnError: false, keepCallSites: true });
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const routes = graph.nodes
      .filter((node) => node.label === "Route")
      .map((node) => `${String(node.properties.framework)} ${String(node.properties.method)} ${String(node.properties.path ?? `<${String(node.properties.pathExpression)}>`)}`)
      .sort();
    const entries = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind !== "main");
    const links = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.properties.via === "grpc")
      .map((rel) => String(byId.get(rel.to)!.properties.qualifiedName));
    return { routes, entries, links };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("C# framework review fixes", () => {
  it("1. a mapper's Map(src, dst) is not a minimal API route", async () => {
    const { routes } = await scan({
      "Program.cs": `using AutoMapper;
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/ok", () => "x");
app.Map("/branch", () => "y");
app.MapGet("/m", Handlers.Get);
public class Dto {}
public class Svc {
  public void Run(IMapper mapper, string src, Dto dto) {
    var dst = new Dto();
    mapper.Map(src, dst);
    mapper.Map(src, dto);
    mapper.Map(src, dst, dto);
    mapper.Map(dto, dst);
  }
}
public static class Handlers { public static string Get() => ""; }`,
    });
    assert.deepEqual(routes, ["aspnet-minimal ALL /branch", "aspnet-minimal GET /m", "aspnet-minimal GET /ok"]);
  });

  it("2. named and case-insensitive attribute arguments", async () => {
    const { routes } = await scan({
      "C.cs": `using Microsoft.AspNetCore.Mvc;
[Route(template: "api/Z")]
public class ZController : ControllerBase {
  [HttpGet(template: "named")] public int A() => 1;
  [HttpGet(Template = "cased")] public int B() => 1;
  [HttpPost(name: "ignored", template: "second")] public int C() => 1;
}`,
    });
    assert.deepEqual(routes, ["aspnet-mvc GET /api/Z/cased", "aspnet-mvc GET /api/Z/named", "aspnet-mvc POST /api/Z/second"]);
  });

  it("3 and 4. Dispose() and generic methods are not actions", async () => {
    const { routes } = await scan({
      "C.cs": `using Microsoft.AspNetCore.Mvc;
[Route("api/d")]
public class DController : ControllerBase, System.IDisposable {
  [HttpGet] public int Real() => 1;
  public void Dispose() {}
  [HttpGet("gen")] public int Gen<T>() => 1;
}`,
    });
    assert.deepEqual(routes, ["aspnet-mvc GET /api/d"]);
  });

  it("5. MVC controller discovery: suffix, [Controller], ancestry; [ApiController] alone is not enough", async () => {
    const { routes } = await scan({
      "C.cs": `using Microsoft.AspNetCore.Mvc;
[Route("poco")] public class PocoController { [HttpGet] public int A() => 1; }
[Controller][Route("attr")] public class Tagged { [HttpGet] public int A() => 1; }
[ApiController][Route("api-only")] public class Lonely { [HttpGet] public int A() => 1; }
[ApiController][Route("ok")] public class OkController : ControllerBase { [HttpGet] public int A() => 1; }
[NonController][Route("non")] public class NonController2 : ControllerBase { [HttpGet] public int A() => 1; }
[Route("g")] public class GenController<T> { [HttpGet] public int A() => 1; }`,
    });
    assert.deepEqual(routes, ["aspnet-mvc GET /attr", "aspnet-mvc GET /ok", "aspnet-mvc GET /poco"]);
  });

  const grpcFiles = (clientFile: string) => ({
    "Protos/order.proto": 'syntax = "proto3";\nservice Order { rpc Place (Req) returns (Req); }\nmessage Req {}\n',
    "Server.cs": `using Grpc.Core;
public class OrderImpl : Order.OrderBase {
  public override Task<Req> Place(Req request, ServerCallContext context) => null;
}`,
    "Client.cs": clientFile,
  });

  it("6. a REST OrderClient is not linked to the gRPC service Order", async () => {
    const { links } = await scan(
      grpcFiles(`namespace Rest;
public class Caller {
  private readonly OrderClient _c;
  public Caller(OrderClient c) { _c = c; }
  public void Go() { _c.Place(null); }
}`),
    );
    assert.deepEqual(links, []);
  });

  it("6. the bare generated client links with a using Grpc.* or an alias, the qualified one always", async () => {
    const withUsing = await scan(
      grpcFiles(`using Grpc.Net.Client;
namespace Rest;
public class Caller {
  private readonly OrderClient _c;
  public Caller(OrderClient c) { _c = c; }
  public void Go() { _c.Place(null); }
}`),
    );
    assert.deepEqual(withUsing.links, ["OrderImpl.Place"]);
    const aliased = await scan(
      grpcFiles(`using OrderClient = Order.OrderClient;
namespace Rest;
public class Caller {
  private readonly OrderClient _c;
  public Caller(OrderClient c) { _c = c; }
  public void Go() { _c.Place(null); }
}`),
    );
    assert.deepEqual(aliased.links, ["OrderImpl.Place"]);
    const qualified = await scan(
      grpcFiles(`namespace Rest;
public class Caller {
  private readonly Order.OrderClient _c;
  public Caller(Order.OrderClient c) { _c = c; }
  public void Go() { _c.Place(null); }
}`),
    );
    assert.deepEqual(qualified.links, ["OrderImpl.Place"]);
  });

  it("7. routes and hubs on a RouteGroupBuilder parameter are relative; an endpoint builder parameter is the root", async () => {
    const { routes, entries } = await scan({
      "E.cs": `using Microsoft.AspNetCore.SignalR;
public class ChatHub : Hub { public void Send() {} }
public static class Ext {
  public static void MapRel(this RouteGroupBuilder g) {
    g.MapGet("/rel", () => "x");
    var inner = g.MapGroup("/in");
    inner.MapGet("/deep", () => "y");
    g.MapHub<ChatHub>("/hub");
  }
  public static void MapRoot(this IEndpointRouteBuilder endpoints) {
    endpoints.MapGet("/root", () => "z");
    endpoints.MapGroup("/g").MapGet("/x", () => "w");
  }
}`,
    });
    assert.deepEqual(routes, ["aspnet-minimal GET /g/x", "aspnet-minimal GET /root", "aspnet-minimal GET </in/deep>", "aspnet-minimal GET </rel>"]);
    const hub = entries.find((entry) => entry.properties.kind === "signalr")!;
    assert.equal(hub.properties.hubPath ?? null, null);
  });
});
