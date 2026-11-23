import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { createDefaultCoreIntegrationRegistry } from "../src/composition/default-registry.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { IGraphContributor } from "../src/core/contracts/graph-contributor.js";
import {
  createCSharpStringResolver,
  csharpStringFromText,
  csharpStringLiteralValue,
  literalText,
  renderCSharpString,
} from "../src/integrations/frameworks/csharp/strings.js";
import { createCSharpReceiverResolver, receiverMatches } from "../src/integrations/frameworks/csharp/receivers.js";
import {
  appSettingsEnvironment,
  appSettingsOf,
  envNameToKey,
  flattenJsonSettings,
  isHierarchicalEnvName,
  keyToEnvName,
  readAppSettings,
  shownValue,
} from "../src/integrations/frameworks/csharp/config-files.js";
import { csharpSqlModelAccesses, csharpTable, csharpTableId, csharpDataModel, recordCSharpDataAccesses } from "../src/integrations/frameworks/csharp/data-shared.js";
import { javaTable } from "../src/integrations/frameworks/java/data-shared.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-p47-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src/Tables.cs"),
    `namespace App.Data;
public static class Tables
{
    public const string Users = "users";
    public const string Schema = "dbo";
    public const string Qualified = Schema + "." + Users;
    public static readonly string Orders = $"{Schema}.orders";
    public static string Items => "items";
}
`,
  );
  await writeFile(
    path.join(root, "src/Repo.cs"),
    `using System;
using static App.Data.Tables;
using Microsoft.Extensions.Configuration;
using System.Net.Http;
namespace App.Data;
public class Db { }
public class Holder { public static Db Shared = new Db(); }
public class MyContext : Microsoft.EntityFrameworkCore.DbContext { }
public class Repo(IConfiguration config)
{
    private readonly HttpClient _http;
    private MyContext Context { get; }
    private readonly IConfiguration cfg;
    public void Run(IHttpClientFactory factory)
    {
        var sql = "select * from " + Users;
        var again = sql;
        var changed = "a";
        changed += "b";
        var named = factory.CreateClient("orders");
        var typed = factory.CreateClient<IOrdersApi>();
        var made = new Db();
        _http.GetAsync("x");
        this.cfg.GetSection("A");
        config["A:B"];
        Context.Set<int>();
        Environment.GetEnvironmentVariable("X");
        Holder.Shared.Go();
        named.GetAsync("y");
        typed.Get();
        made.Go();
        again.Trim();
        changed.Trim();
        MyContext other = new();
        other.Set<int>();
        Tables.Orders.ToString();
    }
}
public interface IOrdersApi { }
`,
  );
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const text = (expression: string, scope = {}) => csharpStringFromText(expression, scope);
const rendered = (expression: string, scope = {}) => {
  const template = text(expression, scope);
  return template === null ? null : renderCSharpString(template);
};

describe("C# string templates (Phase 47 wave 0)", () => {
  it("reads regular, verbatim and raw literals", () => {
    assert.equal(csharpStringLiteralValue('"a\\n\\"b\\""'), 'a\n"b"');
    assert.equal(csharpStringLiteralValue('@"c:\\x""y"'), 'c:\\x"y');
    assert.equal(csharpStringLiteralValue('"""raw "q" text"""'), 'raw "q" text');
    assert.equal(csharpStringLiteralValue('""""a """ b""""'), 'a """ b');
    assert.equal(csharpStringLiteralValue('""'), "");
    assert.equal(csharpStringLiteralValue('$"a{b}"'), null);
    assert.equal(csharpStringLiteralValue("Const.Path"), null);
    const raw = '"""\n    SELECT *\n      FROM users\n    """';
    assert.equal(csharpStringLiteralValue(raw), "SELECT *\n  FROM users");
  });

  it("reads interpolated strings, concatenation, format and nameof", () => {
    assert.equal(rendered('$"select * from {Tables.Users} where id = {id:D} and n = {n,5}"', { dynamic: new Set(["id", "n"]) }), "select * from ${Tables.Users} where id = ${id} and n = ${n}");
    assert.equal(rendered('$"{{literal}} {(a ? "x" : "y")}"', { dynamic: new Set(["a"]) }), '{literal} ${a___"x"_:_"y"}', "a conditional hole is dynamic");
    assert.equal(rendered('$@"a\\{x}"'), "a\\${x}");
    assert.equal(rendered('@$"a{x}b"'), "a${x}b");
    assert.equal(rendered('$$"""{"k": {{v}} }"""'), '{"k": ${v} }');
    assert.equal(rendered('"/api/" + Paths.Users + "/" + nameof(Foo.Bar)'), "/api/${Paths.Users}/Bar");
    assert.equal(rendered('string.Format("{0}/{1:N2}/{{x}}", Base, "u")'), "${Base}/u/{x}");
    assert.equal(rendered('string.Concat("a", "b", C)'), "ab${C}");
    assert.equal(rendered('string.Join("/", "a", b)'), "a/${b}");
    assert.equal(rendered('("a" + "b").ToString()'), "ab");
    assert.equal(rendered('(string)Prefix + "x"'), "${Prefix}x");
    assert.equal(rendered('this.Base + "/x"'), "${Base}/x");
    assert.equal(rendered("Foo()"), null);
    assert.deepEqual(literalText(text('"a" + "b"')), "ab");
    assert.equal(literalText(text('"a" + b')), null);
  });

  it("treats parameters and locals as dynamic and single-assignment locals as their value", () => {
    const locals = new Map([["sql", [{ text: "select 1 from " }, { ref: "Users" }]]]);
    assert.equal(rendered("sql + \" where x\"", { locals, dynamic: new Set(["sql", "Users"]) }), "select 1 from ${Users} where x");
    assert.equal(rendered("Users", { dynamic: new Set(["Users"]) }), "${Users}");
    assert.equal(rendered("opts.Table", { dynamic: new Set(["opts"]) }), null);
  });
});

describe("C# string constants and receiver types through a scan", () => {
  it("resolves constants (fields, properties, using static, qualified) and removes the private facts", async () => {
    const result = await buildCodeGraph(root, { continueOnError: false });
    assert.ok(!result.nodes.some((node) => node.properties.csharpStringConstant !== undefined), "the private constant fact never reaches the graph");
    const graph = view(result);
    // the facts are gone after the scan; build the resolver over a graph that still has them
    const parsed = await parseAll();
    const resolver = createCSharpStringResolver(parsed);
    const run = parsed.nodesWithLabel("Function").find((node) => node.properties.name === "Run")!;
    const at = (expression: string) => {
      const template = csharpStringFromText(expression)!;
      return resolver.resolveAt(template, run);
    };
    assert.equal(at("Users"), "users", "using static");
    assert.equal(at("Tables.Qualified"), "dbo.users");
    assert.equal(at("Tables.Orders"), "dbo.orders");
    assert.equal(at("App.Data.Tables.Items"), "items");
    assert.equal(at("Unknown.Name + \"x\""), "${Unknown.Name}x");
    assert.ok(graph.nodesWithLabel("Field").length > 0);
  });

  it("types receivers: fields, properties, primary constructor, locals, initializers, new, static", async () => {
    const parsed = await parseAll();
    const receivers = createCSharpReceiverResolver(parsed);
    const calls = parsed.nodesWithLabel("Call");
    const call = (callee: string, receiver?: string) => calls.find((node) => node.properties.callee === callee && (receiver === undefined || node.properties.receiver === receiver))!;
    const http = receivers.typeOfCall(call("GetAsync", "_http"));
    assert.equal(http?.typeName, "HttpClient");
    assert.equal(receiverMatches(http, ["HttpClient"], receivers), true);
    assert.equal(receiverMatches(http, ["DbContext"], receivers), false);
    assert.equal(receivers.typeOfCall(call("GetSection"))?.typeName, "IConfiguration", "this.field");
    assert.equal(receivers.typeOfCall(call("Set", "Context"))?.type?.name, "MyContext", "property of a scanned type");
    assert.equal(receiverMatches(receivers.typeOfCall(call("Set", "Context")), ["DbContext"], receivers), true, "a scanned type with an external DbContext base");
    assert.equal(receiverMatches(receivers.typeOfCall(call("Set", "other")), ["DbContext"], receivers), true, "new() target typed");
    const env = receivers.typeOfCall(call("GetEnvironmentVariable"));
    assert.equal(env?.typeName, "Environment");
    assert.equal(env?.via, "static");
    assert.equal(receivers.typeOfCall(call("Go", "Holder.Shared"))?.typeName, "Db", "static member of a scanned type");
    assert.equal(receivers.typeOfCall(call("Go", "made"))?.typeName, "Db");
    const run = parsed.nodesWithLabel("Function").find((node) => node.properties.name === "Run")!;
    assert.equal(receivers.typeOf("typed", run)?.typeName, "IOrdersApi", "CreateClient<T>()");
    assert.equal(receivers.typeOf("named", run), null);
    assert.equal(receivers.initializerOf("named", run), 'factory.CreateClient("orders")');
    assert.equal(receivers.typeOf("again", run), null, "var again = sql: an untyped local");
    assert.equal(receivers.typeOf("config", run)?.typeName, "IConfiguration", "primary-constructor parameter");
    assert.equal(receivers.typeOf("factory", run)?.typeName, "IHttpClientFactory", "parameter");
  });
});

describe("C# data helpers", () => {
  it("makes C# Tables apart from Java's and models and accesses like Java's", () => {
    const graph = new GraphBuilder();
    const users = csharpTable(graph, "[dbo].[Users]", { library: "efcore", declaredIn: "a.cs", line: 3 });
    assert.equal(users, "table:csharp:-:users");
    assert.equal(users, csharpTableId("dbo.USERS"));
    assert.equal(csharpTable(graph, "users"), users, "one Table per name");
    assert.equal(graph.node(users)?.properties.name, "Users");
    assert.notEqual(javaTable(graph, "users"), users);
    const accesses = csharpSqlModelAccesses(graph, "SELECT TOP 5 * FROM [dbo].[Orders] o JOIN Users u ON 1=1 WHERE o.id=@id", "dapper");
    assert.deepEqual(accesses.map((a) => [a.modelId, a.operation]).sort(), [["datamodel:dapper:orders", "read"], ["datamodel:dapper:users", "read"]]);
    assert.equal(csharpSqlModelAccesses(graph, "SELECT COUNT(*) FROM Users", "ado.net")[0]!.operation, "aggregate");
    const entity = csharpDataModel(graph, { name: "User", library: "efcore", scope: "App.Data", table: users, declaredIn: "a.cs", line: 3 });
    assert.equal(entity, "datamodel:efcore:App.Data:User");
    assert.equal(graph.relationshipsOfType("MAPS_TO_TABLE").some((rel) => rel.from === entity && rel.to === users), true);
    graph.addNode({ id: "fn", label: "Function", properties: { name: "f" } });
    graph.addNode({ id: "file:a.cs:function:1:f:call:2:0:x", label: "Call", properties: {} });
    graph.addNode({ id: "file:a.cs", label: "File", properties: { relativePath: "a.cs" } });
    graph.addRelationship({ from: "fn", to: "file:a.cs:function:1:f:call:2:0:x", type: "CALLS", properties: {} });
    recordCSharpDataAccesses(graph, [{ callId: "file:a.cs:function:1:f:call:2:0:x", modelId: entity, operation: "read", library: "efcore", line: 2, expression: "db.Users" }]);
    const rel = graph.relationshipsOfType("ACCESSES_DATA")[0]!;
    assert.deepEqual([rel.from, rel.to, rel.properties.operation, rel.properties.library, rel.properties.direct], ["fn", entity, "read", "efcore", true]);
  });
});

describe("appsettings keys", () => {
  it("flattens JSON with comments, trailing commas and arrays, with lines", () => {
    const flat = flattenJsonSettings(`{
  // c
  "Logging": { "LogLevel": { "Default": "Information", }, },
  "Servers": [ { "Host": "a" }, { "Host": "b" } ],
  /* x */ "Port": 5000, "On": true, "Nothing": null, "Empty": {}, "None": []
}`)!;
    assert.deepEqual(flat.map((e) => `${e.line}:${e.key}=${e.value}:${e.valueType}`), [
      "3:Logging:LogLevel:Default=Information:string",
      "4:Servers:0:Host=a:string",
      "4:Servers:1:Host=b:string",
      "5:Port=5000:number",
      "5:On=true:boolean",
      "5:Nothing=null:null",
      "5:Empty={}:object",
      "5:None=[]:array",
    ]);
    assert.equal(flattenJsonSettings("{ nope"), null);
    assert.equal(flattenJsonSettings("[1]"), null);
  });

  it("matches keys the .NET way and maps environment overrides", () => {
    assert.equal(appSettingsEnvironment("src/appsettings.Production.json"), "Production");
    assert.equal(appSettingsEnvironment("appsettings.json"), null);
    assert.equal(appSettingsEnvironment("appsettings.json.bak"), undefined);
    assert.equal(keyToEnvName("Services:Orders:BaseUrl"), "Services__Orders__BaseUrl");
    assert.equal(envNameToKey("Services__Orders__BaseUrl"), "Services:Orders:BaseUrl");
    assert.equal(isHierarchicalEnvName("A__B"), true);
    assert.equal(isHierarchicalEnvName("A_B"), false);
    const settings = appSettingsOf([
      { key: "Services:Orders:BaseUrl", canonical: "services:orders:baseurl", value: "http://a", valueType: "string", file: "appsettings.json", line: 3, environment: null },
      { key: "Services:Orders:BaseUrl", canonical: "services:orders:baseurl", value: "http://prod", valueType: "string", file: "appsettings.Production.json", line: 2, environment: "Production" },
      { key: "ConnectionStrings:Db", canonical: "connectionstrings:db", value: "Server=a;Password=x;Db=1", valueType: "string", file: "appsettings.json", line: 9, environment: null },
    ]);
    assert.equal(settings.lookup("services__orders:BASEURL")?.value, "http://a");
    assert.equal(settings.lookup("Services:Orders:BaseUrl", { environment: "production" })?.value, "http://prod");
    assert.equal(settings.entriesFor("Services", { below: true }).length, 2);
    assert.equal(shownValue(settings.lookup("ConnectionStrings:Db")!), "Server=a;Password=<redacted>;Db=1");
    assert.equal(shownValue({ key: "Jwt:SigningKey", value: "abc" }), "<redacted>");
    assert.equal(shownValue({ key: "Services:Orders:BaseUrl", value: "https://u:pw@h/x" }), "https://u:<redacted>@h/x");
  });

  it("reads the files of a scan once it holds C# files", async () => {
    await writeFile(path.join(root, "appsettings.json"), `{ "A": { "B": "1" } }`);
    const all = [path.join(root, "appsettings.json"), path.join(root, "src/Repo.cs")];
    const settings = await readAppSettings(root, all);
    assert.deepEqual(settings.entries.map((e) => [e.key, e.file, e.line]), [["A:B", "appsettings.json", 1]]);
    assert.equal((await readAppSettings(root, [all[0]!])).entries.length, 0, "no C# project: no read");
  });
});

describe("wave 0 wiring", () => {
  it("registers the four track schemas and contributors", () => {
    const registry = createDefaultCoreIntegrationRegistry();
    const ids = registry.semanticContributors.map((contributor) => contributor.id);
    for (const id of ["csharp.data-efcore", "csharp.data-sql", "csharp.config-env", "csharp.http-clients", "csharp.strings"]) assert.ok(ids.includes(id), id);
    assert.ok(ids.indexOf("csharp.http-clients") < ids.indexOf("js-ts.http-requests"));
    assert.ok(ids.indexOf("csharp.config-env") < ids.indexOf("js-ts.env-config"));
    assert.ok(ids.indexOf("csharp.data-sql") < ids.indexOf("js-ts.data-access"));
    assert.ok(ids.indexOf("csharp.strings") > ids.indexOf("csharp.http-clients"));
  });
});

// The graph of the temp project parsed with the framework parser only (the private constant facts are still on it).
async function parseAll(): Promise<IGraphContributor> {
  const { csharpFrameworkParser } = await import("../src/integrations/frameworks/csharp/index.js");
  const graph = new GraphBuilder();
  for (const file of ["src/Tables.cs", "src/Repo.cs"]) {
    const parsed = await csharpFrameworkParser.parse(root, path.join(root, file));
    graph.addNodes(parsed.nodes);
    graph.addRelationships(parsed.relationships);
  }
  return graph;
}

function view(result: Awaited<ReturnType<typeof buildCodeGraph>>): IGraphContributor {
  const graph = new GraphBuilder();
  graph.addNodes(result.nodes);
  graph.addRelationships(result.relationships);
  return graph;
}
