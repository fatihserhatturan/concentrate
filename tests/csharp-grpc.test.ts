import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const shortName = (node: GraphNode) => String(node.properties.qualifiedName).replace(/^Acme\.Greet\.(?:Server\.Services\.|Client\.)?/u, "");

function summarize(graph: Graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const callerOf = new Map(graph.relationships.filter((rel) => rel.type === "CALLS").map((rel) => [rel.to, rel.from]));
  const entries = graph.nodes
    .filter((node) => node.label === "EntryPoint" && node.properties.kind === "grpc")
    .map((entry) => {
      const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)!.to;
      return `${String(entry.properties.library)} ${String(entry.properties.trigger)} -> ${shortName(byId.get(handler)!)} registered=${String(entry.properties.registered)}`;
    })
    .sort();
  const links = graph.relationships
    .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.properties.via === "grpc")
    .map((rel) => `${shortName(byId.get(callerOf.get(rel.from)!)!)}:${String(byId.get(rel.from)!.properties.line)} ${String(byId.get(rel.from)!.properties.callee)} -> ${shortName(byId.get(rel.to)!)}`)
    .sort();
  const rpcs = graph.relationships
    .filter((rel) => rel.type === "RPC_IMPLEMENTED_BY")
    .map((rel) => `${String(byId.get(rel.from)!.properties.name)} -> ${shortName(byId.get(rel.to)!)}`)
    .sort();
  return { entries, links, rpcs };
}

describe("gRPC .NET (fixtures/csharp-grpc)", () => {
  let result: ReturnType<typeof summarize>;
  before(async () => {
    result = summarize(await buildCodeGraph(path.resolve("fixtures/csharp-grpc"), { continueOnError: false, keepCallSites: true }));
  });

  it("makes an EntryPoint of each public override rpc method of a class deriving from X.XBase", () => {
    assert.deepEqual(result.entries, [
      "grpc-dotnet Greeter/Chat -> GreeterService.Chat registered=true",
      "grpc-dotnet Greeter/Reset -> AuditServiceBase.Reset registered=true",
      "grpc-dotnet Greeter/SayHello -> AuditService.SayHello registered=true",
      "grpc-dotnet Greeter/SayHello -> GreeterService.SayHello registered=true",
      "grpc-dotnet Greeter/SayHello -> LegacyGreeterService.SayHello registered=false",
      "grpc-dotnet Greeter/SayHellos -> GreeterService.SayHellos registered=true",
      "grpc-dotnet Inventory/GetStock -> InventoryService.GetStock registered=false",
    ]);
  });

  it("links client calls to every implementation, however the client is held", () => {
    assert.deepEqual(result.links, [
      ...["AuditService", "GreeterService", "LegacyGreeterService"].flatMap((impl) => [
        `GreetingApi.Hello:18 SayHelloAsync -> ${impl}.SayHello`,
        `GreetingApi.HelloBlocking:22 SayHello -> ${impl}.SayHello`,
        `Standalone.Direct:44 SayHello -> ${impl}.SayHello`,
        `Standalone.Direct:45 SayHello -> ${impl}.SayHello`,
        `Standalone.Through:50 SayHelloAsync -> ${impl}.SayHello`,
      ]),
      "GreetingApi.Stream:26 SayHellos -> GreeterService.SayHellos",
      "Pinger.Reset:34 Reset -> AuditServiceBase.Reset",
    ].sort());
  });

  it("links the .proto rpcs to the implementations", () => {
    assert.deepEqual(result.rpcs, [
      "Chat -> GreeterService.Chat",
      "Reset -> AuditServiceBase.Reset",
      "SayHello -> AuditService.SayHello",
      "SayHello -> GreeterService.SayHello",
      "SayHello -> LegacyGreeterService.SayHello",
      "SayHellos -> GreeterService.SayHellos",
    ]);
  });
});

describe("gRPC .NET with the generated code in the scan", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "csharp-grpc-"));
    await mkdir(path.join(dir, "obj"), { recursive: true });
    await writeFile(path.join(dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    await writeFile(
      path.join(dir, "obj", "GreetGrpc.cs"),
      `namespace Acme.Greet {
  public static partial class Greeter {
    public abstract partial class GreeterBase {
      public virtual Task<HelloReply> SayHello(HelloRequest request, ServerCallContext context) => throw new Exception();
    }
    public partial class GreeterClient : ClientBase<GreeterClient> {
      public virtual HelloReply SayHello(HelloRequest request) => null;
    }
  }
}`,
    );
    await writeFile(
      path.join(dir, "Service.cs"),
      `using Acme.Greet;
namespace App;
public class Impl : Greeter.GreeterBase {
  public override Task<HelloReply> SayHello(HelloRequest request, ServerCallContext context) => null;
  public override Task<HelloReply> Other(HelloRequest request, ServerCallContext context) => null;
}
public class Caller {
  private readonly Greeter.GreeterClient _c;
  public Caller(Greeter.GreeterClient c) { _c = c; }
  public void Go() { _c.SayHello(new HelloRequest()); }
}`,
    );
  });

  it("recognises the scanned generated base and only its rpcs", async () => {
    const graph = await buildCodeGraph(dir, { continueOnError: false, keepCallSites: true });
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const entries = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "grpc").map((node) => String(node.properties.trigger));
    assert.deepEqual(entries, ["Greeter/SayHello"]);
    const links = graph.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.properties.via === "grpc");
    assert.deepEqual(links.map((rel) => String(byId.get(rel.to)!.properties.qualifiedName)), ["App.Impl.SayHello"]);
    await rm(dir, { recursive: true, force: true });
  });
});
