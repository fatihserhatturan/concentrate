import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

type Graph = Awaited<ReturnType<typeof buildCodeGraph>>;

// "<handler qualified name> <kind> <library> <trigger> <resolved> [registered]" for every EntryPoint of these kinds.
function entries(graph: Graph, kinds: readonly string[]): string[] {
  return graph.nodes
    .filter((node) => node.label === "EntryPoint" && kinds.includes(String(node.properties.kind)))
    .map((entry) => {
      const handlerId = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)!.to;
      const handler = graph.nodes.find((node) => node.id === handlerId)!;
      const { kind, library, trigger, resolved, registered } = entry.properties;
      return `${handler.properties.qualifiedName} ${kind} ${library} ${trigger} ${resolved}${registered === undefined ? "" : ` registered=${registered}`}`;
    })
    .sort();
}

function routes(graph: Graph): string[] {
  return graph.nodes
    .filter((node) => node.label === "Route" && node.properties.framework === "azure-functions")
    .map((route) => `${route.properties.method} ${route.properties.path ?? `<${route.properties.pathExpression}>`} ${route.properties.handlerName}`)
    .sort();
}

async function scan(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-fe-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    return await buildCodeGraph(dir, { continueOnError: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("hosted services (fixtures/csharp-hosted-service)", () => {
  it("finds BackgroundService.ExecuteAsync and IHostedService.StartAsync, with their registration", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-hosted-service"), { continueOnError: false });
    assert.deepEqual(entries(graph, ["hosted-service"]), [
      "HostedServices.Workers.CleanupService.ExecuteAsync hosted-service hosted-service CleanupService true registered=false",
      "HostedServices.Workers.Heartbeat.StartAsync hosted-service hosted-service Heartbeat true registered=true",
      "HostedServices.Workers.PeriodicWorker.ExecuteAsync hosted-service hosted-service ReportWorker true registered=true",
      "HostedServices.Workers.QueueWorker.ExecuteAsync hosted-service hosted-service QueueWorker true registered=true",
      "HostedServices.Workers.WarmupService.StartAsync hosted-service hosted-service WarmupService true registered=true",
    ]);
  });

  it("keeps the shape of every other EntryPoint (declared by the file, handled by the method)", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-hosted-service"), { continueOnError: false });
    const entry = graph.nodes.find((node) => node.label === "EntryPoint" && node.properties.trigger === "QueueWorker")!;
    assert.deepEqual(entry.properties, { kind: "hosted-service", trigger: "QueueWorker", receiverName: null, library: "hosted-service", line: entry.properties.line, handlerName: "ExecuteAsync", resolved: true, registered: true });
    assert.ok(graph.relationships.some((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.to === entry.id && rel.from === "file:Workers/QueueWorker.cs"));
  });

  it("ignores a type of its own named BackgroundService and an abstract service", async () => {
    const graph = await scan({
      "A.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
      "A.cs": `namespace A;
public abstract class BackgroundService { public abstract System.Threading.Tasks.Task ExecuteAsync(System.Threading.CancellationToken t); }
public class Mine : BackgroundService { public override System.Threading.Tasks.Task ExecuteAsync(System.Threading.CancellationToken t) => null; }
`,
    });
    assert.deepEqual(entries(graph, ["hosted-service"]), []);
  });
});

describe("Azure Functions (fixtures/csharp-azure-functions)", () => {
  it("reads the trigger from the parameter attribute, isolated and in-process", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-azure-functions"), { continueOnError: false });
    assert.deepEqual(entries(graph, ["function"]), [
      "Legacy.Functions.LegacyFunctions.Dequeue function azure-functions queue:legacy-orders true",
      "Legacy.Functions.LegacyFunctions.Run function azure-functions http true",
      "Legacy.Functions.LegacyFunctions.Tick function azure-functions timer:0 0 * * * * true",
      "Orders.Functions.BackgroundFunctions.Cleanup function azure-functions timer:0 */5 * * * * true",
      "Orders.Functions.BackgroundFunctions.NightlyReport function azure-functions timer:%ReportSchedule% false",
      "Orders.Functions.BackgroundFunctions.OnAlert function azure-functions servicebus:alerts/billing true",
      "Orders.Functions.BackgroundFunctions.OnItemChange function azure-functions cosmosdb:shop/items true",
      "Orders.Functions.BackgroundFunctions.OnTelemetry function azure-functions eventhub:telemetry true",
      "Orders.Functions.BackgroundFunctions.OnUpload function azure-functions blob:uploads/{name} true",
      "Orders.Functions.BackgroundFunctions.ProcessOrder function azure-functions queue:orders true",
      "Orders.Functions.BackgroundFunctions.ProcessRefund function azure-functions queue:QueueNames.Refunds false",
      "Orders.Functions.ItemFunctions.GetItem function azure-functions http true",
      "Orders.Functions.ItemFunctions.Health function azure-functions http true",
      "Orders.Functions.ItemFunctions.Ping function azure-functions http true",
      "Orders.Functions.ItemFunctions.SaveItem function azure-functions http true",
    ]);
  });

  it("adds a Route per verb under the host.json prefix, and never guesses a constant route", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-azure-functions"), { continueOnError: false });
    assert.deepEqual(routes(graph), [
      "ALL /svc/Ping Ping",
      "GET /api/legacy/{id} Run",
      "GET /svc/items/{id:int} GetItem",
      "GET <Routes.Health> Health",
      "POST /api/legacy/{id} Run",
      "POST /svc/items SaveItem",
      "PUT /svc/items SaveItem",
    ]);
    const route = graph.nodes.find((node) => node.label === "Route" && node.properties.handlerName === "GetItem")!;
    assert.ok(graph.relationships.some((rel) => rel.type === "ROUTE_HANDLED_BY" && rel.from === route.id));
  });

  it("follows an empty routePrefix, a missing host.json and a user attribute of the same name", async () => {
    const graph = await scan({
      "host.json": `{ "version": "2.0", "extensions": { "http": { "routePrefix": "" } } }`,
      "F.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
      "F.cs": `using Microsoft.Azure.Functions.Worker;
namespace F;
public class Fns {
  [Function("Open")] public void Open([HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "open")] object req) {}
  [Function("Bare")] public void Bare(object req) {}
}
`,
      "G.cs": `using Microsoft.Azure.Functions.Worker;
namespace G;
public class HttpTriggerAttribute : System.Attribute { public HttpTriggerAttribute(string x) {} }
public class Fns2 {
  [Function("Mine")] public void Mine([HttpTrigger("x")] object req) {}
}
`,
    });
    assert.deepEqual(routes(graph), ["GET /open Open"]);
    assert.deepEqual(entries(graph, ["function"]), [
      "F.Fns.Bare function azure-functions null false",
      "F.Fns.Open function azure-functions http true",
      "G.Fns2.Mine function azure-functions null false",
    ]);
  });
});

describe("System.CommandLine (fixtures/csharp-commandline)", () => {
  it("names commands by their path and links the handler method or the function holding the lambda", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-commandline"), { continueOnError: false });
    assert.deepEqual(entries(graph, ["cli"]), [
      "FileTool.Cli.Commands.Add cli system-commandline add true",
      "FileTool.Cli.Commands.AddRemote cli system-commandline remote add true",
      "FileTool.Cli.ServeCommand.Run cli system-commandline serve true",
      "FileTool.Cli.SyncCommands.Pull cli system-commandline CommandNames.Sync pull false",
      "FileTool.Program.Main cli system-commandline <root> true",
      "FileTool.Program.Main cli system-commandline remote remove true",
    ]);
  });

  it("reads SetAction, implicit new, collection initializers, Name and inline AddCommand", async () => {
    const graph = await scan({
      "T.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>`,
      "T.cs": `using System.CommandLine;
namespace T;
class Cli {
  static readonly Command Status = new("status", "Shows");
  static Command Build() {
    var root = new RootCommand("x") { Name = "tool" };
    Command init = new("init");
    init.SetAction(Init);
    var nested = new Command("nested") { new Command("deep") };
    root.Subcommands.Add(init);
    root.Add(Status);
    root.AddCommand(new Command("inline"));
    Status.SetAction(parse => 0);
    return root;
  }
  static void Init(ParseResult r) {}
}
`,
    });
    assert.deepEqual(entries(graph, ["cli"]), ["T.Cli.Build cli system-commandline tool status true", "T.Cli.Init cli system-commandline tool init true"]);
  });

  it("does not take a Command of the code's own, or one without System.CommandLine, for the library's", async () => {
    const graph = await scan({
      "U.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
      "U.cs": `namespace U;
public class Command { public Command(string n) {} public void SetHandler(System.Action a) {} }
public class Use { public void Go() { var c = new Command("x"); c.SetHandler(Go); } }
`,
      "V.cs": `namespace V;
public class Other { public void Go() { var c = new Command("y"); c.SetHandler(Go); } }
`,
    });
    assert.deepEqual(entries(graph, ["cli"]), []);
  });
});
