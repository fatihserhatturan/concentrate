import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-config-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return buildCodeGraph(dir, { continueOnError: false });
}

const fnName = (qualified: unknown): string => String(qualified).replace(/^(?:[\w.]*\.)?(\w+\.\w+)$/u, "$1");
const byId = (graph: Graph) => new Map(graph.nodes.map((node) => [node.id, node]));

// `Function qualifiedName -> EnvVar name` (function sources only: routes and files are copies).
function envUses(graph: Graph, access?: string): string[] {
  const nodes = byId(graph);
  return graph.relationships
    .filter((rel) => rel.type === "USES_ENV" && nodes.get(rel.from)?.label === "Function" && (access === undefined || rel.properties.access === access))
    .map((rel) => `${fnName(nodes.get(rel.from)!.properties.qualifiedName)} -> ${nodes.get(rel.to)!.properties.name}`)
    .sort();
}

// `Function -> ConfigValue names` (unique), function sources only.
function reads(graph: Graph): Map<string, string[]> {
  const nodes = byId(graph);
  const result = new Map<string, Set<string>>();
  for (const rel of graph.relationships) {
    if (rel.type !== "CONSUMES_CONFIG") continue;
    const from = nodes.get(rel.from)!;
    if (from.label !== "Function") continue;
    const name = fnName(from.properties.qualifiedName);
    const set = result.get(name) ?? new Set<string>();
    set.add(String(nodes.get(rel.to)!.properties.name));
    result.set(name, set);
  }
  return new Map([...result].map(([name, set]) => [name, [...set].sort()]));
}

const configValues = (graph: Graph) => graph.nodes.filter((node) => node.label === "ConfigValue");

describe("C# configuration and environment (fixtures/csharp-config)", () => {
  let graph: Graph;
  const load = async () => (graph ??= await buildCodeGraph(path.resolve("fixtures/csharp-config"), { continueOnError: false }));

  it("makes a ConfigValue per appsettings leaf, per file, with secrets redacted", async () => {
    await load();
    const nodes = byId(graph);
    const declared = graph.relationships.filter((rel) => rel.type === "DECLARES_CONFIG" && nodes.get(rel.from)!.properties.relativePath !== undefined && String(nodes.get(rel.from)!.properties.relativePath).startsWith("appsettings"));
    assert.equal(declared.length, 28);
    const named = (key: string) => configValues(graph).filter((node) => node.properties.name === key && String(node.id).includes("appsettings"));
    assert.equal(named("Jwt:Issuer").length, 2);
    assert.ok(named("Jwt:Issuer").some((node) => node.id.startsWith("file:appsettings.Production.json:config:")));
    assert.deepEqual(named("Mail:Recipients:1").map((node) => node.properties.value), ["billing@example.com"]);
    assert.deepEqual(named("Jwt:ExpiryMinutes").map((node) => node.properties.valueType).sort(), ["number", "number"]);
    assert.deepEqual(named("Mail:UseSsl").map((node) => node.properties.valueType), ["boolean"]);
    assert.ok(named("Jwt:SigningKey").every((node) => node.properties.value === "<redacted>"));
    assert.deepEqual(named("ConnectionStrings:Orders").map((node) => node.properties.value).sort(), ["Server=db.local;Database=orders;User Id=app;Password=<redacted>;", "Server=prod-db;Database=orders;User Id=app;Password=<redacted>;"]);
    const payments = named("Payments:ApiKey")[0]!;
    assert.equal(payments.properties.value, "<redacted>");
    assert.equal(payments.properties.line, 7);
  });

  it("reads Environment.GetEnvironmentVariable and friends, constants included", async () => {
    await load();
    assert.deepEqual(envUses(graph, "Environment.GetEnvironmentVariable"), [
      "EnvSettings.MachineHome -> HOME",
      "EnvSettings.Override -> Jwt__Issuer",
      "EnvSettings.Queue -> APP_QUEUE_URL",
      "StatusController.Deployment -> DEPLOY_ENV",
      "<top-level> -> AWS_REGION",
    ].sort());
    assert.deepEqual(envUses(graph, "Environment.GetEnvironmentVariables"), ["EnvSettings.FromMap -> DIRECT_VALUE", "EnvSettings.FromMap -> MAP_VALUE"]);
    assert.deepEqual(envUses(graph, "Environment.ExpandEnvironmentVariables"), ["EnvSettings.Expand -> TEMP"]);
    // The file reads it too, with the line.
    const nodes = byId(graph);
    const queue = graph.relationships.find((rel) => rel.type === "USES_ENV" && rel.to === "env:APP_QUEUE_URL" && nodes.get(rel.from)!.label === "File")!;
    assert.deepEqual(queue.properties, { line: 13, access: "Environment.GetEnvironmentVariable" });
    assert.equal(nodes.get(queue.from)!.properties.relativePath, "Infrastructure/EnvSettings.cs");
    // Not constant, and a scanned `Environment` type: nothing.
    const all = envUses(graph).join("\n");
    assert.ok(!all.includes("EnvSettings.Dynamic"));
    assert.ok(!all.includes("SHADOWED_VAR"));
  });

  it("links reads of IConfiguration to the ConfigValue nodes of every appsettings file", async () => {
    await load();
    const result = reads(graph);
    assert.deepEqual(result.get("FeatureFlags.CacheSeconds"), ["Features:Cache:Ttl:Seconds"]);
    assert.deepEqual(result.get("FeatureFlags.BannerText"), ["Features:Banner"]);
    assert.deepEqual(result.get("FeatureFlags.Legacy"), ["Features:Fallback", "Unset:Key"]);
    assert.deepEqual(result.get("FeatureFlags.LogLevels"), ["Logging:LogLevel:Default", "Logging:LogLevel:Microsoft.AspNetCore"]);
    assert.deepEqual(result.get("StatusController.Get"), ["Status:Banner"]);
    const nodes = byId(graph);
    // The two files that define Features:Banner are both consumed.
    const banner = graph.relationships.filter((rel) => rel.type === "CONSUMES_CONFIG" && nodes.get(rel.from)!.properties.qualifiedName === "ConfigDemo.Services.FeatureFlags.BannerText");
    assert.deepEqual(banner.map((rel) => rel.to.replace(/:config:\d+:/u, "|")).sort(), ["file:appsettings.Development.json|Features:Banner", "file:appsettings.json|Features:Banner"]);
    assert.deepEqual(banner[0]!.properties, { localName: "Features:Banner" });
  });

  it("reads the top-level statements: indexers, GetValue, GetConnectionString, sections and options registrations", async () => {
    await load();
    const top = reads(graph).get("<top-level>")!;
    for (const key of ["Features:Banner", "Limits:MaxItems", "ConnectionStrings:Orders", "Retry:Count", "Jwt:Issuer", "Jwt:ExpiryMinutes", "Mail:Host", "Mail:Recipients:0", "Storage:MaxBytes", "Storage:Container", "Status:Banner"]) assert.ok(top.includes(key), key);
    const nodes = byId(graph);
    const retry = configValues(graph).find((node) => node.properties.name === "Retry:Count")!;
    assert.deepEqual({ value: retry.properties.value, valueType: retry.properties.valueType, id: retry.id }, { value: "3", valueType: "default", id: "file:Program.cs:config:10:Retry:Count" });
    assert.ok(graph.relationships.some((rel) => rel.type === "DECLARES_CONFIG" && rel.to === retry.id && nodes.get(rel.from)!.properties.relativePath === "Program.cs"));
    const unset = configValues(graph).find((node) => node.properties.name === "Unset:Key")!;
    assert.deepEqual({ value: unset.properties.value, valueType: unset.properties.valueType }, { value: "", valueType: "unset" });
  });

  it("links IOptions<T>, IOptionsSnapshot<T> and IOptionsMonitor<T> consumers to the keys of the bound section", async () => {
    await load();
    const result = reads(graph);
    assert.deepEqual(result.get("TokenService.TokenService"), ["Jwt:Audience", "Jwt:ExpiryMinutes", "Jwt:Issuer", "Jwt:SigningKey"]);
    assert.deepEqual(result.get("MailSender.MailSender"), ["Mail:Host", "Mail:Port", "Mail:Recipients:0", "Mail:Recipients:1", "Mail:UseSsl"]);
    assert.deepEqual(result.get("StorageMonitor.StorageMonitor"), ["Storage:Container", "Storage:MaxBytes"]);
    const nodes = byId(graph);
    const token = graph.relationships.find((rel) => rel.type === "CONSUMES_CONFIG" && nodes.get(rel.from)!.properties.qualifiedName === "ConfigDemo.Services.TokenService.TokenService")!;
    assert.deepEqual(token.properties, { localName: "options" });
    // The file of the consumer reads them as well.
    assert.ok(graph.relationships.some((rel) => rel.type === "CONSUMES_CONFIG" && nodes.get(rel.from)!.properties.relativePath === "Services/MailSender.cs" && rel.to.endsWith(":Mail:Host")));
  });

  it("adds the env variable that overrides a key a function reads, as a config override", async () => {
    await load();
    assert.deepEqual(envUses(graph, "config override"), [
      "<top-level> -> ConnectionStrings__Orders",
      "<top-level> -> Features__Banner",
      "<top-level> -> Limits__MaxItems",
      "<top-level> -> Status__Banner",
      "FeatureFlags.BannerText -> Features__Banner",
      "FeatureFlags.CacheSeconds -> Features__Cache__Ttl__Seconds",
      "StatusController.Get -> Status__Banner",
    ]);
    const nodes = byId(graph);
    const override = graph.relationships.find((rel) => rel.type === "USES_ENV" && rel.to === "env:Status__Banner" && nodes.get(rel.from)!.properties.qualifiedName === "ConfigDemo.Controllers.StatusController.Get")!;
    assert.deepEqual(override.properties, { line: 17, access: "config override" });
  });

  it("links the routes of a reading handler, and only the lambda's own route for a minimal API", async () => {
    await load();
    const nodes = byId(graph);
    const routeReads = (route: string) =>
      graph.relationships
        .filter((rel) => rel.type === "CONSUMES_CONFIG" && nodes.get(rel.from)!.label === "Route" && nodes.get(rel.from)!.properties.path === route)
        .map((rel) => nodes.get(rel.to)!.properties.name)
        .sort();
    assert.deepEqual(routeReads("/api/status"), ["Status:Banner"]);
    assert.deepEqual(routeReads("/banner"), ["Status:Banner"]);
    assert.deepEqual(routeReads("/region"), []);
  });

  it("ignores indexers of other types", async () => {
    await load();
    const result = reads(graph);
    assert.equal(result.get("Lookup.Dictionary"), undefined);
    assert.equal(result.get("Lookup.Pair"), undefined);
    assert.equal(result.get("Lookup.Own"), undefined);
  });
});

describe("C# configuration reads in other shapes", () => {
  it("handles constants, null-conditional indexers, host builders, extension methods and typeof GetValue", async () => {
    const graph = await scanSources({
      "appsettings.json": '{ "Services": { "Orders": { "BaseUrl": "https://orders.local", "Timeout": 5 } }, "Jwt": { "Issuer": "x", "Audience": "y", "Extra": { "Deep": 1 } }, "Other": { "Key": "z" } }',
      "Keys.cs": 'namespace App; public static class Keys { public const string Orders = "Services:Orders"; public const string Base = Orders + ":BaseUrl"; }',
      "Reader.cs": `namespace App;
public class Reader(IConfiguration config)
{
    public string? One() => config?[Keys.Base];
    public int Two() => (int)config.GetValue(typeof(int), $"{Keys.Orders}:Timeout")!;
    public string? Three() { var orders = config.GetSection(Keys.Orders); return orders["BaseUrl"]; }
    public string? Four(string name) => config[name];
    public string? Five(string name) => config["Services:Orders:" + name];
    public void Six(Dictionary<string, object> bag) { var c = bag["Services:Orders:Timeout"]; }
    public void Seven() { var o = new Other(); config.GetSection("Other").Bind(o); }
}
public class Other { }`,
      "Hosting.cs": `namespace App;
public static class Hosting
{
    public static IServiceCollection AddJwt(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<JwtSettings>(configuration.GetSection("Jwt"));
        return services;
    }
    public static void Build(IHostBuilder host) => host.ConfigureServices((ctx, services) => { var u = ctx.Configuration["Services:Orders:BaseUrl"]; });
}
public class JwtSettings { public string Issuer { get; set; } = ""; public string Audience { get; set; } = ""; }
public class JwtUser(Microsoft.Extensions.Options.IOptions<JwtSettings> options) { }`,
      "Own.cs": `namespace App.Own;
public interface IConfiguration { string? this[string key] { get; } }
public class Own(IConfiguration config) { public string? Read() => config["Services:Orders:BaseUrl"]; }`,
    });
    const result = reads(graph);
    assert.deepEqual(result.get("Reader.One"), ["Services:Orders:BaseUrl"]);
    assert.deepEqual(result.get("Reader.Two"), ["Services:Orders:Timeout"]);
    assert.deepEqual(result.get("Reader.Three"), ["Services:Orders:BaseUrl"]);
    assert.equal(result.get("Reader.Four"), undefined);
    assert.equal(result.get("Reader.Five"), undefined);
    assert.equal(result.get("Reader.Six"), undefined);
    assert.deepEqual(result.get("Reader.Seven"), ["Other:Key"]);
    assert.deepEqual(result.get("Hosting.Build"), ["Services:Orders:BaseUrl"]);
    // `JwtSettings` declares Issuer and Audience: `Jwt:Extra:Deep` is not bound.
    assert.deepEqual(result.get("Hosting.AddJwt"), ["Jwt:Audience", "Jwt:Issuer"]);
    assert.deepEqual(result.get("JwtUser.JwtUser"), ["Jwt:Audience", "Jwt:Issuer"]);
    // The user's own `IConfiguration` is not Microsoft's.
    assert.equal(result.get("Own.Read"), undefined);
    assert.deepEqual(envUses(graph, "config override").filter((entry) => entry.startsWith("Reader.")), [
      "Reader.One -> Services__Orders__BaseUrl",
      "Reader.Three -> Services__Orders__BaseUrl",
      "Reader.Two -> Services__Orders__Timeout",
    ]);
  });

  it("reads Environment through a static using and options registered with AddOptions().Bind", async () => {
    const graph = await scanSources({
      "appsettings.json": '{ "Queue": { "Name": "q", "Depth": 3 }, "Db": { "Host": "h" } }',
      "Program.cs": `using static System.Environment;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOptions<QueueOptions>().Bind(builder.Configuration.GetSection("Queue")).ValidateDataAnnotations();
var region = GetEnvironmentVariable("REGION");
public class QueueOptions { public string Name { get; set; } = ""; }
public class Worker { private readonly Microsoft.Extensions.Options.IOptionsMonitor<QueueOptions> _queue; public Worker(Microsoft.Extensions.Options.IOptionsMonitor<QueueOptions> queue) { _queue = queue; } }`,
    });
    assert.deepEqual(envUses(graph, "Environment.GetEnvironmentVariable"), ["<top-level> -> REGION"]);
    assert.deepEqual(reads(graph).get("Worker.Worker"), ["Queue:Name"]);
  });

  it("does nothing for a repository without C# files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-config-none-"));
    temporary.push(dir);
    await writeFile(path.join(dir, "appsettings.json"), '{ "A": { "B": 1 } }');
    await writeFile(path.join(dir, "app.py"), "print('hi')\n");
    const graph = await buildCodeGraph(dir, { continueOnError: false });
    assert.equal(configValues(graph).length, 0);
  });
});
