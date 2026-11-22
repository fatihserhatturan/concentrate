import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

type Scanned = Awaited<ReturnType<typeof buildCodeGraph>>;

// `aspnet-mvc GET /api/x -> Controllers/XController.cs:12 XController.Get`
function summarize(graph: Scanned, framework?: string): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.nodes
    .filter((node) => node.label === "Route" && (!framework || node.properties.framework === framework))
    .map((route) => {
      const handler = graph.relationships.find((rel) => rel.type === "ROUTE_HANDLED_BY" && rel.from === route.id);
      const target = handler ? String(byId.get(handler.to)!.properties.qualifiedName) : "none";
      const where = route.properties.path ?? `<${route.properties.pathExpression}>`;
      return `${route.properties.framework} ${route.properties.method} ${where} -> ${target} (${route.properties.handlerName})`;
    })
    .sort();
}

const scanFixture = (name: string) => buildCodeGraph(path.resolve("fixtures", name), { continueOnError: false });

async function scanSources(sources: Record<string, string>): Promise<Scanned> {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-routes-"));
  try {
    for (const [file, source] of Object.entries(sources)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), source);
    }
    return await buildCodeGraph(root, { continueOnError: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const strip = (rows: string[]): string[] => rows.map((row) => row.replace(/Catalog\.Api\.(?:Controllers|Admin)\./gu, "").replace(/Todos\.Api\.Endpoints\./gu, ""));

describe("ASP.NET Core controllers (fixtures/csharp-aspnet-controllers)", () => {
  it("joins class and method templates, resolves tokens, inheritance, overrides and verbs", async () => {
    assert.deepEqual(strip(summarize(await scanFixture("csharp-aspnet-controllers"))), [
      "aspnet-mvc ALL /Home/About -> HomeController.About (About)",
      "aspnet-mvc ALL /Home/Index -> HomeController.Index (Index)",
      "aspnet-mvc ALL /api/orders -> OrdersController.Anything (Anything)",
      "aspnet-mvc ALL /api/v1/Products/export -> ProductsController.Export (Export)",
      "aspnet-mvc ALL /api/v2/orders -> OrdersController.Anything (Anything)",
      "aspnet-mvc ALL /terms -> HomeController.Terms (Terms)",
      "aspnet-mvc DELETE /api/legacy/products/{id} -> ProductsController.Remove (Remove)",
      'aspnet-mvc DELETE <"api/orders" + Routes.OrderById> -> OrdersController.Cancel (Cancel)',
      'aspnet-mvc DELETE <"api/v2/orders" + Routes.OrderById> -> OrdersController.Cancel (Cancel)',
      "aspnet-mvc GET /Admin/Users/Index -> UsersController.Index (Index)",
      "aspnet-mvc GET /api/orders/all -> OrdersController.ListAll (ListAll)",
      "aspnet-mvc GET /api/orders/{id} -> OrdersController.Get (Get)",
      "aspnet-mvc GET /api/v1/Products -> ProductsController.List (List)",
      "aspnet-mvc GET /api/v1/Products/exists/{id} -> ProductsController.Exists (Exists)",
      "aspnet-mvc GET /api/v1/Products/ping -> ApiControllerBase.Ping (Ping)",
      "aspnet-mvc GET /api/v1/Products/search/{**query} -> ProductsController.SearchAsync (SearchAsync)",
      "aspnet-mvc GET /api/v1/Products/version -> ProductsController.Version (Version)",
      "aspnet-mvc GET /api/v1/Products/{id:int} -> ProductsController.Get (Get)",
      "aspnet-mvc GET /api/v2/orders/all -> OrdersController.ListAll (ListAll)",
      "aspnet-mvc GET /api/v2/orders/{id} -> OrdersController.Get (Get)",
      "aspnet-mvc GET /health/products -> ProductsController.Health (Health)",
      "aspnet-mvc HEAD /api/v1/Products/exists/{id} -> ProductsController.Exists (Exists)",
      "aspnet-mvc PATCH /api/v1/Products/{id:int} -> ProductsController.Update (Update)",
      "aspnet-mvc POST /Home/Contact -> HomeController.Contact (Contact)",
      "aspnet-mvc POST /admin/users/reset -> UsersController.ResetAll (ResetAll)",
      "aspnet-mvc POST /api/orders/{id}/ship -> OrdersController.Ship (Ship)",
      "aspnet-mvc POST /api/v1/Products -> ProductsController.Create (Create)",
      "aspnet-mvc POST /api/v2/orders/{id}/ship -> OrdersController.Ship (Ship)",
      "aspnet-mvc PUT /api/v1/Products/{id:int} -> ProductsController.Update (Update)",
    ]);
  });

  it("never routes NonAction, static, private, framework overrides, non-controllers or the abstract base", async () => {
    const rows = summarize(await scanFixture("csharp-aspnet-controllers")).join("\n");
    for (const forbidden of ["Helper", "Format", "Static", "Secret", "Missing", "OnActionExecuting", "UserService", "AuditJob", "not-a-route", "api/audit"]) {
      assert.ok(!rows.includes(forbidden), forbidden);
    }
    // Only the concrete controller gets the inherited action.
    assert.ok(!rows.includes("/api/v1/ApiControllerBase"));
  });
});

const MVC_SOURCES: Record<string, string> = {
  "A.cs": `using Microsoft.AspNetCore.Mvc;
namespace App;
[ApiController, Route("api/[controller]")]
public class ItemsController : ControllerBase
{
    [HttpGet] public IActionResult A() => Ok();
    [Route("r")] [HttpGet] [HttpPost] public IActionResult B() => Ok();
    [HttpGet("")] public IActionResult C() => Ok();
    [HttpGet("{id}")] [HttpGet("by/{id}")] public IActionResult D(int id) => Ok();
    [HttpGet("[action]")] public IActionResult ScanAsync() => Ok();
    [HttpGet("~/root")] public IActionResult E() => Ok();
    [AcceptVerbs("PUT")] public IActionResult F() => Ok();
    protected IActionResult P() => Ok();
}
public class SpecialController : ItemsController
{
    [HttpGet("special")] public IActionResult G() => Ok();
}
[Route("own/[controller]")]
public class OwnController : ItemsController { }
public class Mine : ControllerBase
{
    [Route("x")] public IActionResult H() => Ok();
}
`,
  "B.cs": `using Microsoft.AspNetCore.Mvc;
namespace Other;
[ApiController]
[Route(Consts.Base + "/v1")]
public class ConstController : ControllerBase
{
    [HttpGet($"/{Consts.Base}/x")] public IActionResult I() => Ok();
    [HttpPost("y")] public IActionResult J() => Ok();
}
public static class Consts { public const string Base = "b"; }
`,
  "C.cs": `namespace Mine;
public class RouteAttribute : System.Attribute { public RouteAttribute(string t) { } }
public class HttpGetAttribute : System.Attribute { }
[Microsoft.AspNetCore.Mvc.ApiController]
public class OwnAttrController : Microsoft.AspNetCore.Mvc.ControllerBase
{
    [Route("x")] public void H() { }
    [HttpGet] public void K() { }
}
`,
};

describe("controller route semantics", () => {
  it("handles Route + verb combinations, inherited actions and class Route, tokens and constant templates", async () => {
    const rows = summarize(await scanSources(MVC_SOURCES)).map((row) => row.replace(/ -> .*$/u, ""));
    // The inherited actions get one Route per concrete controller; OwnController replaces the base class [Route].
    for (const prefix of ["/api/Items", "/api/Special", "/own/Own"]) {
      for (const expected of [`GET ${prefix}`, `GET ${prefix}/r`, `POST ${prefix}/r`, `GET ${prefix}/{id}`, `GET ${prefix}/by/{id}`, `GET ${prefix}/Scan`, `PUT ${prefix}`]) {
        assert.ok(rows.includes(`aspnet-mvc ${expected}`), expected);
      }
    }
    assert.equal(rows.filter((row) => row === "aspnet-mvc GET /root").length, 3);
    assert.ok(rows.includes("aspnet-mvc GET /api/Special/special"));
    assert.ok(rows.includes("aspnet-mvc ALL /x"));
    // A constant is never guessed; an interpolated absolute template does not take the class prefix.
    assert.ok(rows.includes('aspnet-mvc POST <Consts.Base+"/v1" + "y">'));
    assert.ok(rows.includes('aspnet-mvc GET <$"/{Consts.Base}/x">'));
  });

  it("ignores a user [Route]/[HttpGet] of the same name outside Microsoft.AspNetCore.Mvc", async () => {
    const rows = summarize(await scanSources(MVC_SOURCES)).join("\n");
    assert.ok(!rows.includes("OwnAttrController"));
  });
});

const MINIMAL_SOURCES: Record<string, string> = {
  "Program.cs": `using Microsoft.AspNetCore.Builder;
public class App
{
    public static void Main(string[] args)
    {
        var app = WebApplication.CreateBuilder(args).Build();
        var prefix = Config.Prefix;
        var dyn = app.MapGroup($"/{prefix}");
        var h = new Handlers();
        dyn.MapGet("/a", h.Get);
        app.MapGet(pattern: "/n", handler: () => 1);
        app.MapGet("/o", Handlers.Over);
        app.MapMethods("/m", methods, Handlers.Get2);
        app.MapGet("/self", Self);
        app.MapGroup("/g1").MapGroup("/g2").MapPost("/c", Handlers.Create);
        var nested = app.MapGroup("/n1");
        var deeper = nested.MapGroup("/n2");
        deeper.MapDelete("/d", async (int id) => { });
        var items = new List<int>();
        items.Map("/not", x => x);
        var branched = app;
        app.Map("/branch", b => b.Run(c => c.Response.WriteAsync("x")));
        app.Run();
    }
    static string[] methods = new[] { "GET" };
    static IResult Self() => null!;
}
public class Handlers
{
    public static object Create() => 1;
    public static object Get2() => 1;
    public static object Over(int a) => 1;
    public static object Over(string a) => 1;
    public object Get() => 1;
}
public static class Config { public const string Prefix = "p"; }
`,
};

describe("minimal API semantics", () => {
  it("reads group variables and chains, named arguments, instance method groups and never guesses", async () => {
    const rows = summarize(await scanSources(MINIMAL_SOURCES));
    assert.deepEqual(rows, [
      // A variable methods list is unknown: ALL.
      "aspnet-minimal ALL /m -> Handlers.Get2 (Get2)",
      // A nested group held in local variables; a lambda links to the enclosing function.
      "aspnet-minimal DELETE /n1/n2/d -> App.Main (<lambda>)",
      "aspnet-minimal GET /n -> App.Main (<lambda>)",
      // Two overloads: not guessed.
      "aspnet-minimal GET /o -> none (Over)",
      // A method group of the enclosing class.
      "aspnet-minimal GET /self -> App.Self (Self)",
      // An interpolated group prefix is an expression; `h.Get` is typed through the local `var h = new Handlers()`.
      'aspnet-minimal GET <$"/{prefix}" + "/a"> -> Handlers.Get (Get)',
      // A chained MapGroup().MapGroup().MapPost().
      "aspnet-minimal POST /g1/g2/c -> Handlers.Create (Create)",
    ]);
    // `items.Map(..)` and the middleware branch `app.Map("/branch", b => ...)` are not routes.
  });

  it("keeps the typed lambda parameters on the Route for dependency injection", async () => {
    const graph = await scanFixture("csharp-minimal-api");
    const route = graph.nodes.find((node) => node.label === "Route" && node.properties.path === "/api/v1/todos/{id:int}" && node.properties.method === "PUT")!;
    assert.deepEqual(JSON.parse(String(route.properties.handlerParameters)), [
      { name: "todos", type: "ITodoService", annotations: [{ name: "FromServices", args: [] }] },
      { name: "id", type: "int" },
      { name: "todo", type: "Todo" },
    ]);
    assert.equal(route.properties.handlerName, "<lambda>");
    // The record the plugin leaves on Call nodes is removed.
    assert.ok(!graph.nodes.some((node) => node.label === "Call" && "aspnetRoute" in node.properties));
  });
});

describe("minimal APIs (fixtures/csharp-minimal-api)", () => {
  it("resolves groups, method groups, MapMethods, constants and local/static functions", async () => {
    assert.deepEqual(strip(summarize(await scanFixture("csharp-minimal-api"))), [
      "aspnet-minimal ALL /api/any -> <top-level> (<lambda>)",
      "aspnet-minimal DELETE /api/v1/todos/{id:int} -> <top-level> (DeleteTodo)",
      "aspnet-minimal GET / -> <top-level> (<lambda>)",
      "aspnet-minimal GET /admin/stats -> <top-level> (<lambda>)",
      "aspnet-minimal GET /api/ping -> <top-level> (<lambda>)",
      "aspnet-minimal GET /api/v1/todos -> <top-level> (<lambda>)",
      "aspnet-minimal GET /api/v1/todos/{id:int} -> TodoHandlers.GetTodo (GetTodo)",
      "aspnet-minimal GET /health -> <top-level> (<lambda>)",
      "aspnet-minimal GET /legacy -> LegacyStartup.Configure (<lambda>)",
      "aspnet-minimal GET /reports -> ReportEndpoints.MapTodoReports (<lambda>)",
      "aspnet-minimal GET /reports/open -> ReportEndpoints.MapTodoReports (OpenReport)",
      'aspnet-minimal GET <$"/{Routes.Version}/info"> -> <top-level> (<lambda>)',
      "aspnet-minimal GET <Routes.Export> -> TodoHandlers.Export (Export)",
      "aspnet-minimal HEAD /api/ping -> <top-level> (<lambda>)",
      "aspnet-minimal POST /api/todos/{id:int}/archive -> TodoHandlers.Archive (Archive)",
      "aspnet-minimal POST /api/v1/todos -> TodoHandlers.CreateTodo (CreateTodo)",
      "aspnet-minimal POST /reports/daily -> ReportEndpoints.MapTodoReports (<lambda>)",
      "aspnet-minimal PUT /api/todos/{id:int}/archive -> TodoHandlers.Archive (Archive)",
      "aspnet-minimal PUT /api/v1/todos/{id:int} -> <top-level> (<lambda>)",
    ]);
  });
});

describe("list_routes", () => {
  it("lists controller and minimal API routes with framework, file, line and handler", async () => {
    const { openTestStore } = await import("./helpers/store.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-routes-store-"));
    const store = await openTestStore(path.join(dir, "graph"));
    try {
      for (const [fixture, framework, count] of [["csharp-aspnet-controllers", "aspnet-mvc", 29], ["csharp-minimal-api", "aspnet-minimal", 19]] as const) {
        const graph = await scanFixture(fixture);
        await store.reset();
        await store.write(graph.nodes, graph.relationships);
        const listed = (await callMcpTool(store, "list_routes", { framework })).structuredContent as Record<string, any>;
        assert.equal(listed.routes.length, count, fixture);
        if (framework === "aspnet-mvc") {
          const get = listed.routes.find((row: any) => row.handlerName === "Get" && String(row.fullPath).startsWith("/api/v1/Products"));
          assert.deepEqual(
            { file: get.file, line: get.line, method: get.method, fullPath: get.fullPath, framework: get.framework },
            { file: "Controllers/ProductsController.cs", line: 14, method: "GET", fullPath: "/api/v1/Products/{id:int}", framework: "aspnet-mvc" },
          );
        } else {
          const dynamic = listed.routes.find((row: any) => row.handlerName === "Export");
          assert.equal(dynamic.fullPath ?? null, null);
          assert.equal(dynamic.file, "Program.cs");
        }
      }
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
