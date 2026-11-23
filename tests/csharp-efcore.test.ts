import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { openTestStore } from "./helpers/store.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-efcore-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return buildCodeGraph(dir, { continueOnError: false });
}

const nodeById = (graph: Graph) => new Map(graph.nodes.map((node) => [node.id, node]));

/** Direct accesses as `function operation model expression`, sorted. */
function accesses(graph: Graph, direct = true): string[] {
  const byId = nodeById(graph);
  return graph.relationships
    .filter((rel) => rel.type === "ACCESSES_DATA" && rel.properties.direct === direct && rel.properties.library === "efcore")
    .map((rel) => `${byId.get(rel.from)!.properties.name} ${String(rel.properties.operation)} ${rel.to.replace(/^datamodel:efcore:/u, "")} ${String(rel.properties.expression)}`)
    .sort();
}

const tableNamed = (graph: Graph, name: string) => graph.nodes.find((node) => node.label === "Table" && String(node.properties.name).toLowerCase() === name.toLowerCase());
const columnsOf = (table: GraphNode | undefined) => JSON.parse(String(table?.properties.columns ?? "[]")) as Array<{ name: string; column: string; optional: boolean; isId: boolean }>;

describe("C# EF Core (fixtures/csharp-efcore)", () => {
  it("maps DbSet entities to tables (attribute, ToTable, IEntityTypeConfiguration, convention)", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-efcore"), { continueOnError: false });
    const tables = graph.nodes
      .filter((node) => node.label === "Table" && node.properties.library === "efcore" && node.properties.declaredIn !== "migrations/001_init.sql")
      .map((node) => `${node.properties.name} schema=${String(node.properties.schemaName)} in=${String(node.properties.declaredIn)}`)
      .sort();
    assert.deepEqual(tables, [
      "Customers schema=null in=Models/Customer.cs",
      "Orders schema=null in=Models/Order.cs",
      "catalog_products schema=shop in=Models/Product.cs",
      "invoice_lines schema=billing in=Models/Billing.cs",
      "invoices schema=billing in=Models/Billing.cs",
      "payments schema=null in=Models/Billing.cs",
    ]);
    const maps = graph.relationships
      .filter((rel) => rel.type === "MAPS_TO_TABLE" && rel.from.startsWith("datamodel:efcore:Shop."))
      .map((rel) => `${rel.from.replace("datamodel:efcore:Shop.Models:", "")} -> ${rel.to.replace("table:csharp:-:", "")}`)
      .sort();
    assert.deepEqual(maps, [
      "Customer -> customers",
      "Invoice -> invoices",
      "InvoiceLine -> invoice_lines",
      "Order -> orders",
      "Payment -> payments",
      "Product -> catalog_products",
    ]);
    // [NotMapped] AuditView and Ignore<Draft>() have neither model nor table.
    assert.equal(graph.nodes.some((node) => node.id.includes("AuditView") && node.label === "DataModel"), false);
    assert.equal(graph.nodes.some((node) => node.id.includes(":Draft") && node.label === "DataModel"), false);
    assert.equal(tableNamed(graph, "Drafts"), undefined);
    assert.equal(tableNamed(graph, "AuditViews"), undefined);
  });

  it("reads columns: [Column], HasColumnName, [Key], nullable, and merges the migration's", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-efcore"), { continueOnError: false });
    const products = columnsOf(tableNamed(graph, "catalog_products"));
    assert.deepEqual(products.map((column) => `${column.name}:${column.column}:${column.isId}`), ["ProductKey:ProductKey:true", "Sku:sku_code:false", "Price:Price:false"]);
    assert.deepEqual(columnsOf(tableNamed(graph, "payments")).map((column) => column.column), ["Id", "InvoiceId", "paid_amount"]);
    assert.deepEqual(columnsOf(tableNamed(graph, "invoice_lines")).map((column) => column.column), ["Id", "InvoiceId", "line_text"]);
    const customers = columnsOf(tableNamed(graph, "Customers"));
    assert.equal(customers.find((column) => column.name === "Email")?.optional, true);
    assert.equal(customers.find((column) => column.name === "Name")?.optional, false);
    assert.ok(customers.some((column) => column.name === "CreatedAt"), "the .sql migration adds CreatedAt");
  });

  it("records DbSet accesses with the operation, through every receiver kind", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-efcore"), { continueOnError: false });
    assert.deepEqual(accesses(graph), [
      "AddAsync create Shop.Models:Order _db.Orders.AddAsync",
      "Archive delete Shop.Models:Order this.Orders.Remove",
      "Archive update Shop.Models:Customer Set<Customer>().Update",
      "Cancel delete Shop.Models:Order _db.Orders.Remove",
      "CleanupAsync delete customers shop.Database.ExecuteSqlRawAsync",
      "CountActiveCustomersAsync aggregate Shop.Models:Customer Customers.CountAsync",
      "CountAsync aggregate Shop.Models:Order _db.Orders.CountAsync",
      "CustomerNamesAsync read Shop.Models:Customer _db.Customers",
      "ByDomainAsync read customers _db.Customers.FromSql",
      "GetAsync read Shop.Models:Order _db.Orders.FindAsync",
      "HasProductAsync read Shop.Models:Product shop.Products.AnyAsync",
      "InvoicesOfAsync read Shop.Models:Invoice ctx.Invoices.Where",
      "OpenAsync read Shop.Models:Order _db.Orders.Where",
      "PayAsync create Shop.Models:InvoiceLine ctx.Lines.AddRange",
      "PayAsync create Shop.Models:Payment ctx.Payments.Add",
      "PaymentCountAsync aggregate Shop.Models:Payment ctx.Payments.CountAsync",
      "PurgeAsync delete order_archive _db.Database.ExecuteSqlInterpolatedAsync",
      "RepriceAsync update Shop.Models:Product _db.Set<Product>().ExecuteUpdateAsync",
      "RevenueAsync aggregate Shop.Models:Order shop.Orders.SumAsync",
      "ShippedAsync read orders _db.Orders.FromSqlRaw",
      "<top-level> read Shop.Models:Customer db.Customers.Where",
      "AllProductsRawAsync read Shop.Models:Product _db.Products.FromSqlRaw",
    ].sort());
  });

  it("does not record List<T>, a non-DbContext DbSet-like property, Entry(), ignored entities or the getter's Set<T>()", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-efcore"), { continueOnError: false });
    const names = new Set(accesses(graph).map((line) => line.split(" ")[0]));
    for (const name of ["Put", "MarkModified", "DraftsAsync", "get_Products"]) assert.equal(names.has(name), false, name);
  });

  it("reaches the routes and callers of a function that accesses data (direct: false)", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-efcore"), { continueOnError: false });
    const indirect = accesses(graph, false);
    assert.ok(indirect.includes("Open read Shop.Models:Order _db.Orders.Where"));
    assert.ok(indirect.includes("Create create Shop.Models:Order _db.Orders.AddAsync"));
    const routes = graph.relationships.filter((rel) => rel.type === "ACCESSES_DATA" && rel.properties.direct === false && rel.from.includes(":route:") && rel.from.includes("OrdersController"));
    assert.equal(routes.length, 2);
  });

  it("leaves no private fact on any node", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-efcore"), { continueOnError: false });
    for (const node of graph.nodes) assert.deepEqual(Object.keys(node.properties).filter((key) => key.startsWith("csharpEf")), [], node.id);
  });

  it("answers list_tables, list_data_access and impact_of", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-efcore"), { continueOnError: false });
    const store = await openTestStore(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-efcore-store-")), "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const text = async (tool: string, args: Record<string, unknown>) => (await callMcpTool(store, tool, args)).content[0]?.text ?? "";
      assert.match(await text("list_tables", { name: "catalog_products" }), /sku_code/u);
      const deletes = await text("list_data_access", { library: "efcore", operation: "delete" });
      assert.match(deletes, /Cancel/u);
      assert.doesNotMatch(deletes, /OpenAsync/u);
      assert.match(await text("impact_of", { symbol: "OpenAsync" }), /OrdersController/u);
    } finally {
      await store.close();
    }
  });
});

describe("C# EF Core (sources)", () => {
  it("handles Identity contexts, derived contexts, constants, query clauses and dynamic SQL", async () => {
    const graph = await scanSources({
      "Models.cs": `
namespace App;
public static class Tables { public const string Audit = "audit_log"; }
[System.ComponentModel.DataAnnotations.Schema.Table(Tables.Audit)]
public class AuditEntry { public int Id { get; set; } public string Message { get; set; } = ""; }
public class Note { public int NoteId { get; set; } public string Text { get; set; } = ""; }
public class Tag { public int Id { get; set; } }
public class ApplicationUser { public string Id { get; set; } = ""; }
`,
      "Contexts.cs": `
using Microsoft.EntityFrameworkCore;
namespace App;
public class AppContext : IdentityDbContext<ApplicationUser>
{
    public DbSet<AuditEntry> Audit { get; set; }
    public DbSet<Note> Notes { get; set; }
    public int NoteCount() => Notes.Count();
    public void Fill()
    {
        foreach (var n in Notes) { }
        var found = from n in Notes join t in Tags on n.NoteId equals t.Id select n;
    }
    public DbSet<Tag> Tags { get; set; }
}
public class ReportingContext : AppContext { }
public class Runner
{
    public void Run(ReportingContext ctx, string table, DbContext generic)
    {
        ctx.Notes.RemoveRange(ctx.Notes);
        ctx.Audit.Add(new AuditEntry());
        ctx.Database.ExecuteSqlRaw("DELETE FROM " + table);
        ctx.Database.ExecuteSqlRaw($"UPDATE notes SET Text = {table}");
        generic.Set<Tag>().ToList();
    }
}
`,
    });
    assert.deepEqual(accesses(graph), [
      "Fill read App:Note Notes",
      "Fill read App:Tag Tags",
      "NoteCount aggregate App:Note Notes.Count",
      "Run create App:AuditEntry ctx.Audit.Add",
      "Run delete App:Note ctx.Notes.RemoveRange",
      "Run read App:Tag generic.Set<Tag>().ToList",
      "Run update notes ctx.Database.ExecuteSqlRaw",
    ].sort());
    assert.equal(tableNamed(graph, "audit_log")?.properties.library, "efcore");
    assert.equal(tableNamed(graph, "Notes")?.properties.library, "efcore");
  });

  it("does not treat a user's own DbContext class as EF Core", async () => {
    const graph = await scanSources({
      "A.cs": `
namespace App;
public class DbContext { }
public class Row { public int Id { get; set; } }
public class MyDb : DbContext { public System.Collections.Generic.List<Row> Rows { get; } = new(); public void Go() { Rows.Add(new Row()); } }
`,
    });
    assert.deepEqual(accesses(graph), []);
    assert.equal(graph.nodes.filter((node) => node.label === "DataModel").length, 0);
  });
});
