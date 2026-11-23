import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

const PROJECT = '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-http-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "App.csproj"), PROJECT);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return buildCodeGraph(dir, { continueOnError: false });
}

// The fixture with its localhost URLs replaced by other hosts, so the linker keeps the absolute URL (the bases show).
async function scanFixtureWithHosts(): Promise<Graph> {
  const source = path.resolve("fixtures/csharp-http-clients");
  const files: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (!entry.name.endsWith(".md") && entry.name !== "Gateway.csproj") files[path.relative(source, full)] = (await readFile(full, "utf8")).replace(/http:\/\/(svc:s3cret@)?localhost:(\d+)/gu, "https://$1host$2.example.com");
    }
  };
  await visit(source);
  return scanSources(files);
}

// `Type.Method expression` -> `httpClient METHOD url` of every Call that has a request.
function requests(graph: Graph): Record<string, string> {
  const found: Record<string, string> = {};
  for (const node of graph.nodes) {
    if (node.label !== "Call" || node.properties.httpClient === undefined) continue;
    const match = /:function:\d+:(.+?):call:\d+:\d+:(.*)$/u.exec(node.id)!;
    const owner = match[1]!.split(".").slice(-2).join(".");
    found[`${owner} ${match[2]}`] = `${node.properties.httpClient} ${node.properties.httpMethod} ${node.properties.httpUrl}`;
  }
  return found;
}

const requested = (graph: Graph): string[] => {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "REQUESTS")
    .map((rel) => `${byId.get(rel.from)!.properties.expression} -> ${byId.get(rel.to)!.properties.method} ${byId.get(rel.to)!.properties.fullPath}`)
    .sort();
};

describe("C# outbound HTTP (fixtures/csharp-http-clients)", () => {
  it("records typed, named, plain and Refit requests with the bases of the registrations", async () => {
    const graph = await scanFixtureWithHosts();
    assert.deepEqual(requests(graph), {
      "OrdersClient.GetOrderAsync _http.GetFromJsonAsync": "httpclient-factory GET https://host5001.example.com/api/orders/${id}",
      "OrdersClient.PlaceAsync _http.PostAsJsonAsync": "httpclient-factory POST https://host5001.example.com/api/orders",
      "OrdersClient.CancelAsync _http.DeleteAsync": "httpclient-factory DELETE https://host5001.example.com/api/orders/${id}",
      "OrdersClient.RawAsync _http.GetStringAsync": "httpclient-factory GET null",
      "InventoryClient.GetStockAsync http.GetFromJsonAsync": "httpclient-factory GET https://host5002.example.com/api/inventory/${sku}",
      "InventoryClient.ReserveAsync new HttpRequestMessage": "httpclient-factory PUT https://host5002.example.com/api/inventory/${sku}/reserve",
      "InventoryClient.IsHealthyAsync new HttpRequestMessage": "httpclient-factory GET https://host5002.example.com/api/inventory/health",
      "BillingGateway.InvoicesAsync client.GetStringAsync": "httpclient-factory GET https://host5003.example.com/api/billing/invoices",
      'BillingGateway.IssueAsync _factory.CreateClient("billing").PostAsync': "httpclient-factory POST https://host5003.example.com/api/billing/invoices",
      "BillingGateway.AuditAsync _audit.GetStringAsync": "httpclient-factory GET ${config:Services:Audit:BaseUrl}/api/audit/events",
      "StatusProbe.PingAsync client.GetAsync": "httpclient GET https://host5002.example.com/api/inventory/health",
      "StatusProbe.LegacyAsync http.GetAsync": "httpclient GET https://host5004.example.com/api/legacy/ping",
      "StatusProbe.LegacyAsync http.GetStringAsync": "httpclient GET ${legacy}/api/legacy/status",
      "StatusProbe.DynamicAsync http.GetStringAsync": "httpclient GET null",
      "CatalogService.FindAsync catalog.GetProduct": "refit GET https://host5006.example.com/api/catalog/products/${id}",
      "CatalogService.AddAsync catalog.CreateProduct": "refit POST https://host5006.example.com/api/catalog/products",
      "CatalogService.RemoveAsync catalog.DeleteProduct": "refit DELETE https://host5006.example.com/api/catalog/products/${id}",
      "ShippingService.StatusAsync _shipping.Status": "refit GET https://host5005.example.com/api/shipping/${orderId}/status",
    });
  });

  it("makes no request of a scanned class with HttpClient-looking methods, an attribute-less Refit method, or a private fact leak", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-http-clients"), { continueOnError: false });
    const all = requests(graph);
    assert.equal(Object.keys(all).some((key) => key.startsWith("ResponseCache")), false);
    assert.equal(Object.keys(all).some((key) => key.includes("Describe")), false);
    for (const node of graph.nodes) assert.deepEqual(Object.keys(node.properties).filter((key) => key.startsWith("csharpHttp")), [], node.id);
  });

  it("links the requests to the routes of the project", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-http-clients"), { continueOnError: false });
    assert.deepEqual(requested(graph), [
      "_factory.CreateClient(\"billing\").PostAsync -> POST /api/billing/invoices",
      "_http.DeleteAsync -> DELETE /api/orders/{id}",
      "_http.GetFromJsonAsync -> GET /api/orders/{id}",
      "_http.PostAsJsonAsync -> POST /api/orders",
      "_shipping.Status -> GET /api/shipping/{orderId}/status",
      "catalog.CreateProduct -> POST /api/catalog/products",
      "catalog.DeleteProduct -> DELETE /api/catalog/products/{id}",
      "catalog.GetProduct -> GET /api/catalog/products/{id}",
      "client.GetAsync -> GET /api/inventory/health",
      "client.GetStringAsync -> GET /api/billing/invoices",
      "http.GetFromJsonAsync -> GET /api/inventory/{sku}",
      "new HttpRequestMessage -> GET /api/inventory/health",
      "new HttpRequestMessage -> PUT /api/inventory/{sku}/reserve",
    ]);
  });
});

describe("C# outbound HTTP shapes", () => {
  it("reads Uri joins, post-built messages, default clients, config defaults and ignores other receivers and tests", async () => {
    const graph = await scanSources({
      "appsettings.json": '{ "Api": { "Root": "https://api.example.com/v2" } }',
      "Program.cs": `
var builder = WebApplication.CreateBuilder(args);
var config = builder.Configuration;
builder.Services.AddHttpClient(c => c.BaseAddress = new Uri("https://default.example.com"));
builder.Services.AddHttpClient("search", c => c.BaseAddress = new Uri(config["Api:Root"] + "/search/"));
builder.Services.AddHttpClient("fallback", c => c.BaseAddress = new Uri(config["Missing:Url"] ?? "https://fallback.example.com"));
builder.Services.AddHttpClient("unknown").ConfigureHttpClient(c => c.BaseAddress = new Uri(config["Missing:Url"]!));
`,
      "Clients.cs": `
public class Callers(IHttpClientFactory factory, HttpClient http)
{
    private const string Host = "https://consts.example.com";
    public async Task Joined() => await http.GetAsync(new Uri(new Uri(Host), "/items?page=2"));
    public async Task Post()
    {
        var request = new HttpRequestMessage();
        request.Method = HttpMethod.Post;
        request.RequestUri = new Uri(Host + "/things");
        await http.SendAsync(request);
    }
    public async Task Custom() => await http.SendAsync(new HttpRequestMessage(new HttpMethod("PURGE"), Host + "/cache"));
    public async Task Initializer() => await http.SendAsync(new HttpRequestMessage { Method = HttpMethod.Delete, RequestUri = new Uri(Host + "/init") });
    public async Task Default() { var c = factory.CreateClient(); await c.GetAsync("/home"); }
    public async Task Search() { using var c = factory.CreateClient("search"); await c.GetAsync("query?q=1"); }
    public async Task Fallback() { var c = factory.CreateClient("fallback"); await c.GetAsync("/ok"); }
    public async Task Unknown() { var c = factory.CreateClient("unknown"); await c.GetAsync("/x"); }
    public async Task Unsent() { var request = new HttpRequestMessage(HttpMethod.Get, Host + "/never"); Console.WriteLine(request); }
}
public class Other
{
    private readonly Cache _cache = new();
    public async Task Run() => await _cache.GetAsync("/not/http");
    public async Task Typed(MyClient mine) => await mine.GetAsync("/also/not");
}
public class Cache { public Task GetAsync(string key) => Task.CompletedTask; }
public class MyClient { public Task GetAsync(string key) => Task.CompletedTask; }
public class Mine : HttpClient { public async Task Own() => await GetAsync("/inherited"); public async Task Via(Mine other) => await other.GetAsync("/derived"); }
`,
      "Tests/ClientTests.cs": `
public class ClientTests { public async Task T(HttpClient http) => await http.GetAsync("https://tests.example.com/skip"); }
`,
    });
    assert.deepEqual(requests(graph), {
      "Callers.Joined http.GetAsync": "httpclient GET https://consts.example.com/items",
      "Callers.Post new HttpRequestMessage": "httpclient POST https://consts.example.com/things",
      "Callers.Custom new HttpRequestMessage": "httpclient null https://consts.example.com/cache",
      "Callers.Initializer new HttpRequestMessage": "httpclient DELETE https://consts.example.com/init",
      "Callers.Default c.GetAsync": "httpclient-factory GET https://default.example.com/home",
      "Callers.Search c.GetAsync": "httpclient-factory GET https://api.example.com/v2/search/query",
      "Callers.Fallback c.GetAsync": "httpclient-factory GET https://fallback.example.com/ok",
      "Callers.Unknown c.GetAsync": "httpclient-factory GET ${config:Missing:Url}/x",
      "Mine.Own GetAsync": "httpclient GET /inherited",
      "Mine.Via other.GetAsync": "httpclient GET /derived",
    });
  });

  it("matches Refit overloads, base interfaces and constants, and skips an unrelated interface", async () => {
    const graph = await scanSources({
      "Api.cs": `
using Refit;
public static class Paths { public const string Users = "/users"; }
public interface IBase { [Get("/base/ping")] Task Ping(); }
public interface IApi : IBase
{
    [Get(Paths.Users + "/{id}")] Task<string> Find(int id);
    [Put("/users/{id}")] Task Save(int id, string body);
    [Patch("/users/{id}")] Task Patch(int id);
    [Head("/users")] Task Exists();
    [Options("/users")] Task Allowed();
    [Get("/list")] Task List();
    [Get("/list")] Task List(int page);
}
public interface IPlain { Task<string> Find(int id); }
public class Use(IApi api, IPlain plain)
{
    public async Task Run()
    {
        await api.Find(1); await api.Save(1, "x"); await api.Patch(1); await api.Exists(); await api.Allowed(); await api.Ping(); await api.List();
        await plain.Find(2);
    }
}
public class Build { public IApi Make() => RestService.For<IApi>(new HttpClient { BaseAddress = new Uri("https://users.example.com/api") }); }
`,
    });
    assert.deepEqual(requests(graph), {
      "Use.Run api.Find": "refit GET https://users.example.com/api/users/${id}",
      "Use.Run api.Save": "refit PUT https://users.example.com/api/users/${id}",
      "Use.Run api.Patch": "refit PATCH https://users.example.com/api/users/${id}",
      "Use.Run api.Exists": "refit HEAD https://users.example.com/api/users",
      "Use.Run api.Allowed": "refit OPTIONS https://users.example.com/api/users",
      "Use.Run api.Ping": "refit GET https://users.example.com/api/base/ping",
      "Use.Run api.List": "refit GET https://users.example.com/api/list",
    });
  });

  it("does not take a scanned HttpClient type of the user's own for the library", async () => {
    const graph = await scanSources({
      "Own.cs": `
namespace Mine { public class HttpClient { public Task GetAsync(string url) => Task.CompletedTask; } }
namespace Mine.Use { public class User { public async Task Go(Mine.HttpClient http) => await http.GetAsync("/own"); } }
`,
    });
    assert.deepEqual(requests(graph), {});
  });
});
