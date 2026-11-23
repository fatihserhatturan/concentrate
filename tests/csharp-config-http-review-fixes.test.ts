import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

// Phase 47 review fixes, track F2 (configuration, environment and outbound HTTP): each case is the reviewer's reproduction.

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function scan(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-f2-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return buildCodeGraph(dir, { continueOnError: false });
}

const byId = (graph: Graph) => new Map(graph.nodes.map((node) => [node.id, node]));
const configValue = (graph: Graph, name: string, file = "appsettings.json"): string | undefined =>
  graph.nodes.find((node) => node.label === "ConfigValue" && node.properties.name === name && node.id.includes(file.replace(/\./gu, ".")))?.properties.value as string | undefined;

const httpUrls = (graph: Graph): string[] => graph.nodes.filter((node) => node.label === "Call" && node.properties.httpUrl !== undefined).map((node) => `${String(node.properties.httpMethod)} ${String(node.properties.httpUrl)}`).sort();

// `route path -> sorted names` of the Route's own USES_ENV / CONSUMES_CONFIG.
function routeLinks(graph: Graph, type: "USES_ENV" | "CONSUMES_CONFIG"): string[] {
  const nodes = byId(graph);
  return graph.relationships
    .filter((rel) => rel.type === type && nodes.get(rel.from)?.label === "Route")
    .map((rel) => `${String(nodes.get(rel.from)!.properties.path)} -> ${String(nodes.get(rel.to)!.properties.name)}`)
    .sort();
}

describe("secrets in appsettings (review F2 items 1 and 7)", () => {
  it("redacts every credential parameter of a connection string, quoted values included", async () => {
    const graph = await scan({
      "appsettings.json": `{
 "Storage": "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc==;EndpointSuffix=core.windows.net",
 "Bus": "Endpoint=sb://x/;SharedAccessKeyName=a;SharedAccessKey=zzz",
 "Sas": "BlobEndpoint=https://x;SharedAccessSignature=sv=2020&sig=abc",
 "Db": "Host=h;Username=u;Pwd = pw ;Password='quoted;semi'",
 "Dq": "Host=h;Password=\\"dq;rest\\";Port=1",
 "Other": "Host=h;ApiKey=k1;Secret=s1;Token=t1;AccessToken=a1;Trailing=ok",
 "Conn": "Server=h;User Id=u;password=xx"
}`,
      "P.cs": "class P { }",
    });
    assert.equal(configValue(graph, "Storage"), "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=<redacted>;EndpointSuffix=core.windows.net");
    assert.equal(configValue(graph, "Bus"), "Endpoint=sb://x/;SharedAccessKeyName=a;SharedAccessKey=<redacted>");
    assert.match(configValue(graph, "Sas") ?? "", /SharedAccessSignature=<redacted>$/u);
    assert.equal(configValue(graph, "Db"), "Host=h;Username=u;Pwd = <redacted>;Password=<redacted>");
    assert.equal(configValue(graph, "Dq"), "Host=h;Password=<redacted>;Port=1");
    assert.equal(configValue(graph, "Other"), "Host=h;ApiKey=<redacted>;Secret=<redacted>;Token=<redacted>;AccessToken=<redacted>;Trailing=ok");
    assert.equal(configValue(graph, "Conn"), "Server=h;User Id=u;password=<redacted>");
    for (const node of graph.nodes) for (const leak of ["abc==", "zzz", "semi", "dq;", "rest", "k1", "s1"]) assert.ok(!String(node.properties.value ?? "").includes(leak) || node.label !== "ConfigValue", `${leak} leaked`);
  });

  it("treats a lone Key under jwt/auth/encryption sections as secret, and keeps numeric password/token settings", async () => {
    const graph = await scan({
      "appsettings.json": `{
 "Jwt": {"Key": "k1", "Issuer": "x"},
 "Encryption": {"Key": "k2"},
 "Cache": {"Key": "plain"},
 "Password": {"RequiredLength": 8, "RequireDigit": true},
 "Auth": {"TokenLifetime": 3, "Password": "pw", "Secret": 5}
}`,
      "P.cs": "class P { }",
    });
    assert.equal(configValue(graph, "Jwt:Key"), "<redacted>");
    assert.equal(configValue(graph, "Jwt:Issuer"), "x");
    assert.equal(configValue(graph, "Encryption:Key"), "<redacted>");
    assert.equal(configValue(graph, "Cache:Key"), "plain");
    assert.equal(configValue(graph, "Password:RequiredLength"), "8");
    assert.equal(configValue(graph, "Password:RequireDigit"), "true");
    assert.equal(configValue(graph, "Auth:TokenLifetime"), "3");
    assert.equal(configValue(graph, "Auth:Password"), "<redacted>");
    assert.equal(configValue(graph, "Auth:Secret"), "<redacted>");
  });
});

describe("env and config reads of minimal-API handlers (review F2 items 2 and 3)", () => {
  const program = `using Microsoft.AspNetCore.Builder;
var builder = WebApplication.CreateBuilder(args);
var startup = Environment.GetEnvironmentVariable("STARTUP");
var app = builder.Build();
app.MapGet("/lam", () => Environment.GetEnvironmentVariable("LAM"));
app.MapGet("/grp", Handlers.Get);
app.MapGet("/local", Local);
string Local() => Environment.GetEnvironmentVariable("LOCALFN") + builder.Configuration["C"];
app.MapGet("/cfg", (IConfiguration cfg) => cfg["A:B"]);
app.Run();
public static class Handlers { public static string Get() => Environment.GetEnvironmentVariable("METHODGROUP"); }
`;
  it("a method-group handler's env reads reach its Route again, startup variables stay off every route", async () => {
    const graph = await scan({ "appsettings.json": `{"A":{"B":"1"},"C":"2"}`, "Program.cs": program });
    const env = routeLinks(graph, "USES_ENV");
    assert.ok(env.includes("/lam -> LAM"), env.join("\n"));
    assert.ok(env.includes("/grp -> METHODGROUP"), env.join("\n"));
    assert.ok(env.includes("/local -> LOCALFN"), env.join("\n"));
    assert.ok(!env.some((line) => line.endsWith("STARTUP")), env.join("\n"));
    assert.ok(!env.some((line) => line.startsWith("/lam") && line !== "/lam -> LAM"), env.join("\n"));
    const config = routeLinks(graph, "CONSUMES_CONFIG");
    assert.ok(config.includes("/local -> C"), config.join("\n"));
    assert.ok(config.includes("/cfg -> A:B"), config.join("\n"));
    assert.ok(!config.some((line) => line.startsWith("/lam")), config.join("\n"));
  });

  it("two minimal routes on one line keep their own lambda's reads", async () => {
    const graph = await scan({
      "Program.cs": `using Microsoft.AspNetCore.Builder;
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/b", () => Environment.GetEnvironmentVariable("B1")); app.MapGet("/c", () => Environment.GetEnvironmentVariable("C1"));
app.MapGet("/d", async (HttpContext ctx) => { var f = () => Environment.GetEnvironmentVariable("D1"); await Task.Run(() => Environment.GetEnvironmentVariable("D2")); });
app.Run();
`,
    });
    const env = routeLinks(graph, "USES_ENV");
    assert.deepEqual(env, ["/b -> B1", "/c -> C1", "/d -> D1", "/d -> D2"]);
  });
});

describe("IOptions<T> narrowing and x.Configuration (review F2 items 4 and 5)", () => {
  it("honours [ConfigurationKeyName] and skips non-public members", async () => {
    const graph = await scan({
      "appsettings.json": `{"Sec":{"renamed":"r","Prop":"p","Other":"o","Hidden":"h","Static":"s"}}`,
      "Opts.cs": `using Microsoft.Extensions.Configuration; using Microsoft.Extensions.Options; using Microsoft.Extensions.DependencyInjection;
namespace App;
public class WithAttr { [ConfigurationKeyName("renamed")] public string Prop {get;set;} public string Other {get;set;} private string Hidden {get;set;} public static string Static {get;set;} }
public class Reg { void A(IServiceCollection s, IConfiguration c){ s.Configure<WithAttr>(c.GetSection("Sec")); } }
public class UseO { public UseO(IOptions<WithAttr> o){} }
`,
    });
    const nodes = byId(graph);
    const read = graph.relationships
      .filter((rel) => rel.type === "CONSUMES_CONFIG" && nodes.get(rel.from)?.label === "Function" && String(nodes.get(rel.from)!.properties.qualifiedName).includes("UseO"))
      .map((rel) => String(nodes.get(rel.to)!.properties.name))
      .sort();
    assert.deepEqual(read, ["Sec:Other", "Sec:renamed"]);
  });

  it("x.Configuration counts only for an unresolved root, not a scanned type without that member", async () => {
    const graph = await scan({
      "appsettings.json": `{"Jwt":{"Issuer":"i"}}`,
      "Svc.cs": `using Microsoft.Extensions.Configuration;
namespace App;
public class Holder { public string Name {get;set;} }
public class Fake { void M(Holder h){ var x = h.Configuration["Jwt:Issuer"]; } }
public class Real { void M(Unknown.Builder b){ var x = b.Configuration["Jwt:Issuer"]; } }
`,
    });
    const nodes = byId(graph);
    const readers = graph.relationships
      .filter((rel) => rel.type === "CONSUMES_CONFIG" && nodes.get(rel.from)?.label === "Function")
      .map((rel) => String(nodes.get(rel.from)!.properties.qualifiedName));
    assert.ok(readers.some((name) => name.includes("Real")), readers.join(","));
    assert.ok(!readers.some((name) => name.includes("Fake")), readers.join(","));
  });
});

describe("outbound HTTP URLs (review F2 items 6, 9 and 10)", () => {
  it("resolves a request against the base address the .NET way", async () => {
    const graph = await scan({
      "appsettings.json": `{"Svc":{"Api":"http://h/api","Slash":"http://h/api/"}}`,
      "Svc.cs": `using System.Net.Http; using Microsoft.Extensions.Configuration; using Microsoft.Extensions.DependencyInjection;
namespace App;
public class Reg { public void Add(IServiceCollection s, IConfiguration c){
  s.AddHttpClient("a", h => h.BaseAddress = new Uri(c["Svc:Api"]));
  s.AddHttpClient("b", h => h.BaseAddress = new Uri(c["Svc:Slash"]));
} }
public class Use { IHttpClientFactory f; public Use(IHttpClientFactory f){this.f=f;}
 async Task M(){
  var a = f.CreateClient("a"); await a.GetAsync("v1/x"); await a.GetAsync("/v1/y"); await a.GetAsync("");
  var b = f.CreateClient("b"); await b.GetAsync("v1/x"); await b.GetAsync("/v1/y"); await b.GetAsync("http://other/z");
 } }
`,
    });
    assert.deepEqual(httpUrls(graph), [
      "GET http://h/api",
      "GET http://h/api/v1/x",
      "GET http://h/v1/x",
      "GET http://h/v1/y",
      "GET http://h/v1/y",
      "GET http://other/z",
    ].sort());
  });

  it("resolves new Uri(base, relative) and follows a local holding the Uri", async () => {
    const graph = await scan({
      "Svc.cs": `using System.Net.Http;
namespace App;
public class Use { HttpClient h;
 async Task M(){
  var u = new Uri(new Uri("http://h/api/v2"), "v1/x");
  await h.GetAsync(u);
  await h.GetAsync(new Uri(new Uri("http://h/api/"), "/root"));
 } }
`,
    });
    assert.deepEqual(httpUrls(graph), ["GET http://h/api/v1/x", "GET http://h/root"]);
  });

  it("resolves GetSection(...).GetValue and never writes raw quotes or expression text into httpUrl", async () => {
    const graph = await scan({
      "appsettings.json": `{"Svc":{"Url":"http://svc/a"},"Hook":"https://hooks.example.com/services/T0/B0/PATHTOKEN"}`,
      "X.cs": `using System.Net.Http; using Microsoft.Extensions.Configuration;
namespace App;
public class X { HttpClient h; IConfiguration c; string key;
 async Task M(){
  await h.GetAsync(c.GetSection("Svc").GetValue<string>("Url") + "/q");
  await h.GetAsync(c.GetSection("Svc")["Url"] + "/w");
  await h.GetAsync(c.GetValue<string>("Nope") + "/n");
  await h.GetAsync(c.GetSection("Nope3").GetValue<string>(key) + "/dyn");
  await h.GetAsync(c[key] + "/dyn2");
  await h.GetAsync(Compute("secret-arg") + "/call");
 } string Compute(string s) => s; }
`,
    });
    const urls = httpUrls(graph);
    assert.ok(urls.includes("GET http://svc/a/q"), urls.join("\n"));
    assert.ok(urls.includes("GET http://svc/a/w"), urls.join("\n"));
    assert.ok(urls.includes("GET ${config:Nope}/n"), urls.join("\n"));
    assert.ok(urls.includes("GET ${expr}/dyn"), urls.join("\n"));
    assert.ok(urls.includes("GET ${expr}/dyn2"), urls.join("\n"));
    for (const url of urls) assert.ok(!/["']/u.test(url), `raw quotes in ${url}`);
  });

  it("uses a Refit RestService.For base per call site, and compares client names case-sensitively", async () => {
    const graph = await scan({
      "appsettings.json": `{"Services":{"Orders":{"BaseUrl":"https://orders.example.com/api/"}}}`,
      "Api.cs": `using Refit; namespace App;
public interface IOrdersApi { [Get("/orders/{id}")] Task<O> Get(int id); }
public class O {}
`,
      "Use.cs": `using Refit; using System.Net.Http; using Microsoft.Extensions.DependencyInjection; using Microsoft.Extensions.Configuration;
namespace App;
public class Reg { void Add(IServiceCollection s, IConfiguration c){
  s.AddRefitClient<IOrdersApi>().ConfigureHttpClient(h => h.BaseAddress = new Uri(c["Services:Orders:BaseUrl"]));
  s.AddHttpClient("Lit", h => h.BaseAddress = new Uri("http://lit"));
} }
public class Injected { IOrdersApi api; public Injected(IOrdersApi api){this.api=api;} async Task Run(){ await api.Get(1); } }
public class Manual { async Task Run(){ var a = RestService.For<IOrdersApi>("http://rest/z"); await a.Get(2); } }
public class Names { IHttpClientFactory f; public Names(IHttpClientFactory f){this.f=f;} async Task M(){ var l = f.CreateClient("Lit"); await l.GetAsync("/ok"); var c = f.CreateClient("LIT"); await c.GetAsync("/case"); } }
`,
    });
    const urls = httpUrls(graph);
    assert.ok(urls.includes("GET https://orders.example.com/api/orders/${id}"), urls.join("\n"));
    assert.ok(urls.includes("GET http://rest/z/orders/${id}"), urls.join("\n"));
    assert.ok(urls.includes("GET http://lit/ok"), urls.join("\n"));
    assert.ok(urls.includes("GET /case"), urls.join("\n"));
  });
});
