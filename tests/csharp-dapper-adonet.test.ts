import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

function accesses(graph: Graph, direct = true): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "ACCESSES_DATA" && (rel.properties.direct !== false) === direct)
    .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${rel.to.replace(/^datamodel:/u, "")} ${rel.properties.operation} ${rel.properties.library}`)
    .sort();
}

const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-sql-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return buildCodeGraph(dir, { continueOnError: false });
}

describe("C# Dapper and ADO.NET (fixtures/csharp-dapper-adonet)", () => {
  it("records the tables of every Dapper and ADO.NET statement", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-dapper-adonet"), { continueOnError: false });
    assert.deepEqual(accesses(graph), [
      "Audit -> ado.net:auditlog create ado.net",
      "CloseAsync -> dapper:orders update dapper",
      "CountCustomers -> dapper:customers aggregate dapper",
      "EmailOf -> ado.net:customers read ado.net",
      "Everything -> ado.net:customers read ado.net",
      "Find -> dapper:orders read dapper",
      "Import -> ado.net:auditlog create ado.net",
      "Insert -> dapper:orders create dapper",
      "ListByCustomerAsync -> dapper:customers read dapper",
      "ListByCustomerAsync -> dapper:orders read dapper",
      "Overview -> dapper:customers read dapper",
      "Overview -> dapper:orders read dapper",
      "PurgeAsync -> dapper:orders delete dapper",
      "Remove -> ado.net:customers delete ado.net",
      "RenameAsync -> ado.net:customers update ado.net",
      "Revenue -> dapper:orders read dapper",
      "SearchBy -> dapper:orders read dapper",
    ]);
  });

  it("reaches the tables from the controller and skips what names no table", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-dapper-adonet"), { continueOnError: false });
    const indirect = accesses(graph, false);
    assert.ok(indirect.some((line) => line.startsWith("Get ->") && line.includes("read dapper")));
    assert.ok(indirect.some((line) => line.startsWith("Close ->") && line.includes("update dapper")));
    assert.ok(indirect.some((line) => line.startsWith("Rename ->") && line.includes("update ado.net")));
    const direct = new Set(accesses(graph).map((line) => line.split(" ")[0]));
    for (const name of ["Run", "Recent", "Reset", "Dynamic", "Make", "Query", "Execute"]) assert.ok(!direct.has(name), name);
    const tables = graph.nodes.filter((node) => node.label === "Table").map((node) => node.id).sort();
    assert.deepEqual(tables, ["table:csharp:-:auditlog", "table:csharp:-:customers", "table:csharp:-:orders"]);
    // Private facts never reach the graph.
    assert.ok(!graph.nodes.some((node) => Object.keys(node.properties).some((key) => key.startsWith("csharpSql"))));
  });
});

describe("C# Dapper and ADO.NET rules", () => {
  it("requires a connection or command receiver and reads the SQL shapes", async () => {
    const graph = await scanSources({
      "Repo.cs": `using System.Data;
using System.Data.Common;
using Dapper;
using Microsoft.Data.SqlClient;
namespace App;
public static class T { public const string Items = "Items"; }
public class Other { public int Query(string s) => 0; public int Execute(string s) => 0; }
public class Factory { public IDbConnection Create() => null!; }
public class Repo(IDbConnection db, Other other, Factory factory) {
  public void A() { db.Query("SELECT * FROM A1"); }
  public void B() { other.Query("SELECT * FROM B1"); other.Execute("DELETE FROM B1"); }
  public void C() { var conn = factory.Create(); conn.Execute("DELETE FROM C1"); }
  public void D() { using var conn = new SqlConnection("x"); conn.Query(sql: "SELECT 1 FROM D1"); conn.Query(new CommandDefinition("SELECT 1 FROM D2")); }
  public void E(string t) { db.Query($"SELECT * FROM {t}"); db.Query($"SELECT * FROM E1 WHERE a = {t}"); }
  public void F() { var sql = "UPDATE F1 SET a = 1"; db.Execute(sql); }
  public void G() { db.Execute("sp_g", commandType: CommandType.StoredProcedure); db.Execute("INSERT INTO " + T.Items + " VALUES (1)"); }
  public void H(DbConnection c) { var cmd = c.CreateCommand(); cmd.CommandText = "SELECT * FROM H1"; var other = new Other(); other.Query("SELECT * FROM H2"); }
}
`,
    });
    assert.deepEqual(accesses(graph).map((line) => line.replace(/ -> \w+(?:\.net)?:/u, " -> ")), [
      "A -> a1 read dapper",
      "D -> d1 read dapper",
      "D -> d2 read dapper",
      "E -> e1 read dapper",
      "F -> f1 update dapper",
      "G -> items create dapper",
      "H -> h1 read ado.net",
    ]);
  });
});
