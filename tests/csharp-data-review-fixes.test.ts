import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { csharpStringFromText, renderCSharpString } from "../src/integrations/frameworks/csharp/strings.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-data-review-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return buildCodeGraph(dir, { continueOnError: false });
}

const nodeById = (graph: Graph) => new Map(graph.nodes.map((node) => [node.id, node]));
const modelName = (id: string): string => id.replace(/^datamodel:\w+:/u, "").replace(/^.*:/u, "");

/** `function operation model` of every direct access, sorted. */
function direct(graph: Graph, library?: string): string[] {
  const byId = nodeById(graph);
  return graph.relationships
    .filter((rel) => rel.type === "ACCESSES_DATA" && rel.properties.direct === true && (library === undefined || rel.properties.library === library))
    .map((rel) => `${String(byId.get(rel.from)!.properties.name)} ${String(rel.properties.operation)} ${modelName(rel.to)}`)
    .sort();
}

/** `route path -> operation model` of every access a Route reaches, sorted. */
function routeAccesses(graph: Graph): string[] {
  const byId = nodeById(graph);
  return graph.relationships
    .filter((rel) => rel.type === "ACCESSES_DATA" && byId.get(rel.from)?.label === "Route")
    .map((rel) => `${String(byId.get(rel.from)!.properties.path)} ${String(rel.properties.operation)} ${modelName(rel.to)}`)
    .sort();
}

const tableNamed = (graph: Graph, name: string) => graph.nodes.find((node) => node.label === "Table" && String(node.properties.name).toLowerCase() === name.toLowerCase());
const columnsOf = (table: GraphNode | undefined) =>
  JSON.parse(String(table?.properties.columns ?? "[]")) as Array<{ name: string; column: string; optional: boolean; isId: boolean }>;

describe("C# data access review fixes (track F1)", () => {
  it("types a lambda parameter per lambda when two lambdas name it with different types", async () => {
    const graph = await scanSources({
      "Models.cs": `using Microsoft.EntityFrameworkCore;
namespace A;
public class Order { public int Id { get; set; } }
public class Audit { public int Id { get; set; } }
public class AppCtx : DbContext { public DbSet<Order> Orders { get; set; } }
public class AuditCtx : DbContext { public DbSet<Audit> Audits { get; set; } }
`,
      "Program.cs": `using A;
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders", (AppCtx db) => db.Orders.ToList());
app.MapGet("/audits", (AuditCtx db) => db.Audits.ToList());
app.MapGet("/nested", (AppCtx db) => { Func<AuditCtx, int> f = (AuditCtx db) => db.Audits.Count(); return db.Orders.Count(); });
app.Run();
`,
    });
    assert.deepEqual(routeAccesses(graph), ["/audits read Audit", "/nested aggregate Audit", "/nested aggregate Order", "/orders read Order"]);
  });

  it("gives a local-function handler only its own body and separates two lambdas on one line", async () => {
    const graph = await scanSources({
      "Models.cs": `using Microsoft.EntityFrameworkCore;
namespace A;
public class Order { public int Id { get; set; } }
public class Cust { public int Id { get; set; } }
public class Line { public int Id { get; set; } }
public class AppCtx : DbContext { public DbSet<Order> Orders { get; set; } public DbSet<Cust> Custs { get; set; } public DbSet<Line> Lines { get; set; } }
`,
      "Program.cs": `using A;
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders", (AppCtx db) => db.Orders.ToList());
app.MapGet("/local", Local);
IResult Local(AppCtx db) { db.Custs.ToList(); return Results.Ok(); }
app.MapGet("/one", (AppCtx db) => db.Orders.Count()); app.MapGet("/two", (AppCtx db) => db.Lines.Count());
app.Run();
`,
    });
    assert.deepEqual(routeAccesses(graph), ["/local read Cust", "/one aggregate Order", "/orders read Order", "/two aggregate Line"]);
    const local = graph.nodes.find((node) => node.label === "Route" && node.properties.path === "/local")!;
    assert.equal(local.properties.handlerName, "Local");
    assert.equal(local.properties.handlerStartLine, 5);
    assert.equal(local.properties.handlerEndLine, 5);
    assert.equal(typeof local.properties.handlerStartColumn, "number");
    assert.equal(typeof local.properties.handlerEndColumn, "number");
    const one = graph.nodes.find((node) => node.label === "Route" && node.properties.path === "/one")!;
    const two = graph.nodes.find((node) => node.label === "Route" && node.properties.path === "/two")!;
    assert.equal(one.properties.handlerStartLine, 6);
    assert.ok((one.properties.handlerEndColumn as number) < (two.properties.handlerStartColumn as number));
  });

  it("does not rename the owner entity's table for ToTable after OwnsOne / HasOne / Navigation", async () => {
    const graph = await scanSources({
      "Models.cs": `using Microsoft.EntityFrameworkCore;
namespace A;
public class Addr { public string Street { get; set; } = ""; }
public class Order { public int Id { get; set; } public Addr Addr { get; set; } = new(); }
public class AppCtx : DbContext {
  public DbSet<Order> Orders { get; set; }
  protected override void OnModelCreating(ModelBuilder mb) {
    mb.Entity<Order>().OwnsOne(o => o.Addr).ToTable("addresses");
    mb.Entity<Order>(e => { e.OwnsMany(o => o.Addr).ToTable("addresses2"); e.Navigation(o => o.Addr).ToTable("x"); e.HasOne(o => o.Addr).WithMany().ToTable("y"); });
  }
}
`,
    });
    assert.ok(tableNamed(graph, "Orders"));
    assert.equal(tableNamed(graph, "addresses"), undefined);
    assert.equal(tableNamed(graph, "addresses2"), undefined);
    assert.equal(tableNamed(graph, "x"), undefined);
    assert.equal(tableNamed(graph, "y"), undefined);
  });

  it("maps only public properties (or explicit [Column] / HasColumnName) and not computed ones", async () => {
    const graph = await scanSources({
      "Models.cs": `using Microsoft.EntityFrameworkCore;
using System.ComponentModel.DataAnnotations.Schema;
namespace A;
public class Order {
  public int Id { get; set; }
  public string Name { get; set; } = "";
  private string Secret { get; set; } = "";
  protected string Prot { get; set; } = "";
  internal string Intern { get; set; } = "";
  [Column("hidden_col")] private string Explicit { get; set; } = "";
  private string Fluent { get; set; } = "";
  public string Full => Name + "x";
  public string Computed { get { return Name; } }
  public string NoInit { get; }
  public string WithInit { get; } = "";
  public string InitOnly { get; init; } = "";
  public int? Qty { get; set; }
  public string Opt { get; set; } = "";
}
public class AppCtx : DbContext {
  public DbSet<Order> Orders { get; set; }
  protected override void OnModelCreating(ModelBuilder mb) {
    mb.Entity<Order>().Property("Fluent").HasColumnName("fl");
    mb.Entity<Order>(e => { e.Property(o => o.Opt).IsRequired(false); e.Property(o => o.Qty).IsRequired(); });
  }
}
`,
    });
    const columns = columnsOf(tableNamed(graph, "Orders"));
    assert.deepEqual(columns.map((column) => column.name), ["Id", "Name", "Explicit", "Fluent", "WithInit", "InitOnly", "Qty", "Opt"]);
    assert.equal(columns.find((column) => column.name === "Explicit")!.column, "hidden_col");
    assert.equal(columns.find((column) => column.name === "Fluent")!.column, "fl");
    // IsRequired(false) makes a non-nullable property optional; IsRequired() makes a nullable one required.
    assert.equal(columns.find((column) => column.name === "Opt")!.optional, true);
    assert.equal(columns.find((column) => column.name === "Qty")!.optional, false);
    assert.equal(columns.find((column) => column.name === "Name")!.optional, false);
    // The private marker of the parse plugin is removed.
    assert.ok(!graph.nodes.some((node) => node.properties.csharpEfUnmapped !== undefined));
  });

  it("skips stored procedures per command, not per member", async () => {
    const graph = await scanSources({
      "Repo.cs": `using System.Data;
using Microsoft.Data.SqlClient;
using Dapper;
namespace A;
public class R {
  private readonly string _cs = "x";
  public void Mixed() {
    using var conn = new SqlConnection(_cs);
    using var a = new SqlCommand("sp_x", conn) { CommandType = CommandType.StoredProcedure };
    using var b = new SqlCommand("SELECT * FROM RealTable", conn);
    using var c = conn.CreateCommand(); c.CommandText = "DELETE FROM Other";
    using var d = new SqlCommand("sp_d", conn); d.CommandType = CommandType.StoredProcedure;
    using var e = conn.CreateCommand(); e.CommandText = "sp_e"; e.CommandType = CommandType.StoredProcedure;
    var rows = conn.Query("SELECT * FROM Dp"); var sp = conn.Query("sp", commandType: CommandType.StoredProcedure);
    var more = conn.Query("SELECT * FROM Dp2", commandType: CommandType.Text);
  }
}
`,
    });
    const tables = [...new Set(direct(graph).map((entry) => entry.split(" ").at(-1)!))].sort();
    assert.deepEqual(tables, ["Dp", "Dp2", "Other", "RealTable"].map((name) => name.toLowerCase()).sort());
  });

  it("treats an interface that declares DbSet properties as the context that implements it", async () => {
    const graph = await scanSources({
      "A.cs": `using Microsoft.EntityFrameworkCore;
namespace A;
public class Order { public int Id { get; set; } }
public interface IAppDbContext { DbSet<Order> Orders { get; } Task<int> SaveChangesAsync(CancellationToken ct); }
public class AppDbContext : DbContext, IAppDbContext { public DbSet<Order> Orders => Set<Order>(); }
public interface IUnrelated { DbSet<Order> Orders { get; } }
public class Handler {
  private readonly IAppDbContext _db; private readonly IUnrelated _other;
  public Handler(IAppDbContext db, IUnrelated other) { _db = db; _other = other; }
  public async Task H() { var l = await _db.Orders.ToListAsync(); _db.Orders.Add(new Order()); }
  public void U() { _other.Orders.Count(); }
}
`,
    });
    assert.deepEqual(direct(graph, "efcore"), ["H create Order", "H read Order"]);
  });

  it("maps context-level Add / Update / Remove / Find by the argument type or type argument", async () => {
    const graph = await scanSources({
      "A.cs": `using Microsoft.EntityFrameworkCore;
namespace A;
public class Order { public int Id { get; set; } }
public class Cust { public int Id { get; set; } }
public class Other { public int Id { get; set; } }
public class ShopCtx : DbContext { public DbSet<Order> Orders { get; set; } public DbSet<Cust> Custs { get; set; } }
public class Ctl {
  private readonly ShopCtx _context;
  public Ctl(ShopCtx context) { _context = context; }
  public async Task Create(Order order) { _context.Add(order); await _context.AddAsync(new Cust()); }
  public void Edit(Order order) { _context.Update(order); }
  public void Bulk(List<Cust> custs) { _context.RemoveRange(custs); }
  public async Task Find(int id) { var o = await _context.FindAsync<Order>(id); var c = _context.Find<Cust>(id); }
  public void Skip(Other other, int x) { _context.Add(other); _context.Remove(Make()); _context.Attach(x); }
  private Order Make() => new Order();
  public void Lists(List<Order> list) { list.Add(null); }
}
`,
    });
    assert.deepEqual(direct(graph, "efcore"), [
      "Bulk delete Cust",
      "Create create Cust",
      "Create create Order",
      "Edit update Order",
      "Find read Cust",
      "Find read Order",
    ]);
  });

  it("stops reading the chain at materialization", async () => {
    const graph = await scanSources({
      "A.cs": `using Microsoft.EntityFrameworkCore;
namespace A;
public class Order { public int Id { get; set; } }
public class AppCtx : DbContext { public DbSet<Order> Orders { get; set; } }
public class W {
  public void A(AppCtx db) { db.Orders.ToList().Add(null); }
  public void B(AppCtx db) { db.Orders.Where(o => o.Id == 1).ToArray().ToList().Remove(null); }
  public void C(AppCtx db) { db.Orders.Add(new Order()); }
  public void D(AppCtx db) { db.Orders.Where(o => true).ExecuteDelete(); }
  public void E(AppCtx db) { var n = db.Orders.Count(); }
}
`,
    });
    assert.deepEqual(direct(graph, "efcore"), ["A read Order", "B read Order", "C create Order", "D delete Order", "E aggregate Order"]);
  });

  it("folds integer, char and bool literals in a string concatenation", () => {
    const render = (text: string): string | null => {
      const template = csharpStringFromText(text);
      return template ? renderCSharpString(template) : null;
    };
    assert.equal(render(`"SELECT * FROM T LIMIT " + 10`), "SELECT * FROM T LIMIT 10");
    assert.equal(render(`"a" + 'b' + "c"`), "abc");
    assert.equal(render(`"x" + true`), "xTrue");
    assert.equal(render(`$"LIMIT {10}"`), "LIMIT 10");
    assert.equal(render(`"n" + 5L`), "n5");
    // A bare literal alone is not a string.
    assert.equal(render("10"), null);
  });
});
