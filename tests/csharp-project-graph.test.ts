import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

type Scan = Awaited<ReturnType<typeof buildCodeGraph>>;

const scan = (directory: string): Promise<Scan> => buildCodeGraph(path.resolve(directory), { continueOnError: false });
const strip = (id: string) => id.replace(/^file:/u, "");

const projects = (graph: Scan) => graph.nodes.filter((node) => node.label === "Package" && node.properties.manager === "dotnet");

function project(graph: Scan, name: string) {
  const found = projects(graph).find((node) => node.properties.name === name);
  assert.ok(found, `project ${name} in ${projects(graph).map((node) => node.properties.name).join(", ")}`);
  return found;
}

const nameOf = (graph: Scan, id: string) => String(graph.nodes.find((node) => node.id === id)?.properties.name);

function projectEntry(graph: Scan, name: string) {
  const file = String(project(graph, name).properties.projectFile);
  return graph.nodes.find((node) => node.id === `entrypoint:csharp:${file}`);
}

const runs = (graph: Scan, entryId: string) => graph.relationships.filter((rel) => rel.type === "RUNS" && rel.from === entryId).map((rel) => rel.to);

describe("C# project graph: fixtures/csharp-solution", () => {
  it("makes a Package per project with its properties", async () => {
    const graph = await scan("fixtures/csharp-solution");
    assert.deepEqual(projects(graph).map((node) => `${node.properties.relativePath} ${node.properties.name}`).sort(), [
      "src/Shop.Core Shop.Core",
      "src/Shop.Data Shop.Data",
      "src/Shop.Web Shop.Web",
      "tests/Shop.Tests Shop.Tests",
      "tools/Orphan Orphan",
    ]);
    const web = project(graph, "Shop.Web").properties;
    assert.equal(web.sdk, "Microsoft.NET.Sdk.Web");
    assert.equal(web.executable, true);
    assert.equal(web.projectFile, "src/Shop.Web/Shop.Web.csproj");
    assert.equal(web.unresolved, 2);
    assert.deepEqual(JSON.parse(String(web.targetFrameworks)), ["net8.0"]);
    assert.deepEqual(JSON.parse(String(web.solutions)), ["Shop.sln", "Shop.slnx"]);
    assert.deepEqual(JSON.parse(String(project(graph, "Shop.Data").properties.targetFrameworks)), ["net8.0", "net6.0"]);
    assert.equal(project(graph, "Shop.Tests").properties.isTestProject, true);
    assert.equal(project(graph, "Shop.Core").properties.isTestProject, false);
    assert.equal(project(graph, "Orphan").properties.outputType, "Exe");
    assert.deepEqual(JSON.parse(String(project(graph, "Orphan").properties.solutions)), []);
  });

  it("links projects by ProjectReference and keeps package references out of the project edges", async () => {
    const graph = await scan("fixtures/csharp-solution");
    const ids = new Set(projects(graph).map((node) => node.id));
    const edges = graph.relationships
      .filter((rel) => rel.type === "PACKAGE_IMPORTS_PACKAGE" && ids.has(rel.from))
      .map((rel) => `${nameOf(graph, rel.from)} -> ${nameOf(graph, rel.to)} (${rel.properties.dependencyType})`)
      .sort();
    assert.ok(edges.includes("Shop.Data -> Shop.Core (project)"), edges.join("\n"));
    assert.ok(edges.includes("Shop.Web -> Shop.Core (project)"), edges.join("\n"));
    assert.ok(edges.includes("Shop.Web -> Shop.Data (project)"), edges.join("\n"));
    assert.ok(edges.includes("Shop.Tests -> Shop.Core (project)"), edges.join("\n"));
    assert.equal(edges.filter((edge) => edge.startsWith("Shop.Core ->")).length, 0);
    assert.ok(!edges.some((edge) => edge.includes("(package)")), "third-party packages are not project nodes");
  });

  it("puts every .cs file in its project's package", async () => {
    const graph = await scan("fixtures/csharp-solution");
    const contained = (name: string) =>
      graph.relationships.filter((rel) => rel.type === "PACKAGE_CONTAINS_FILE" && rel.from === project(graph, name).id).map((rel) => strip(rel.to)).filter((file) => file.endsWith(".cs")).sort();
    assert.ok(contained("Shop.Core").includes("src/Shop.Core/Domain/Order.cs"));
    assert.ok(contained("Shop.Web").includes("src/Shop.Web/Legacy/Launcher.cs"));
    assert.deepEqual(contained("Orphan"), ["tools/Orphan/Program.cs"]);
    assert.ok(contained("Shop.Tests").every((file) => file.startsWith("tests/Shop.Tests/")));
  });

  it("declares an EntryPoint per executable project only", async () => {
    const graph = await scan("fixtures/csharp-solution");
    const entries = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "csharp-project");
    assert.deepEqual(entries.map((node) => node.id).sort(), ["entrypoint:csharp:src/Shop.Web/Shop.Web.csproj", "entrypoint:csharp:tools/Orphan/Orphan.csproj"]);
    for (const name of ["Shop.Core", "Shop.Data", "Shop.Tests"]) assert.equal(projectEntry(graph, name), undefined, name);
    const web = projectEntry(graph, "Shop.Web")!;
    assert.equal(web.properties.library, "dotnet");
    assert.equal(web.properties.resolved, true);
    assert.ok(graph.relationships.some((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.from === "file:src/Shop.Web/Shop.Web.csproj" && rel.to === web.id));
  });

  it("runs the top-level statements of Web (CS7022: Launcher.Main is not an entrypoint) and Orphan's Main", async () => {
    const graph = await scan("fixtures/csharp-solution");
    const webRuns = runs(graph, projectEntry(graph, "Shop.Web")!.id);
    assert.equal(webRuns.length, 1);
    assert.match(webRuns[0]!, /^file:src\/Shop\.Web\/Program\.cs:function:\d+:<top-level>$/u);
    const mainEntries = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "main").map((node) => node.id);
    assert.ok(!mainEntries.some((id) => id.includes("Launcher.cs")), mainEntries.join("\n"));
    assert.ok(mainEntries.some((id) => id.includes("src/Shop.Web/Program.cs")));
    assert.ok(mainEntries.some((id) => id.includes("tools/Orphan/Program.cs")));
    const orphanRuns = runs(graph, projectEntry(graph, "Orphan")!.id);
    assert.equal(orphanRuns.length, 1);
    assert.match(orphanRuns[0]!, /^file:tools\/Orphan\/Program\.cs:function:\d+:Orphan\.Program\.Main$/u);
  });
});

async function inlineScan(files: Record<string, string>): Promise<Scan> {
  const root = await mkdtemp(path.join(os.tmpdir(), "csharp-project-graph-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    return await scan(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SDK = (extra = "") => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>${extra}</PropertyGroup></Project>`;

describe("C# project graph: inline cases", () => {
  it("keeps the first of two projects in one directory", async () => {
    const graph = await inlineScan({
      "app/A.csproj": SDK(),
      "app/B.csproj": SDK(),
      "app/Program.cs": "class P { static void Main() {} }\n",
    });
    assert.deepEqual(projects(graph).map((node) => node.properties.name), ["A"]);
    assert.equal(projects(graph)[0]!.properties.projectFile, "app/A.csproj");
  });

  it("a Web SDK project with OutputType Library has no project EntryPoint", async () => {
    const graph = await inlineScan({
      "Lib/Lib.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>`,
      "Lib/Thing.cs": "class Thing {}\n",
    });
    assert.equal(project(graph, "Lib").properties.executable, false);
    assert.equal(graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "csharp-project").length, 0);
  });

  it("an executable project without Main or top-level statements is unresolved", async () => {
    const graph = await inlineScan({ "Tool/Tool.csproj": SDK(), "Tool/Thing.cs": "class Thing {}\n" });
    const entry = projectEntry(graph, "Tool")!;
    assert.equal(entry.properties.resolved, false);
    assert.deepEqual(runs(graph, entry.id), []);
  });

  it("CS7022 is per project: files outside any project keep both kinds, and a root project owns its Mains without top-level statements", async () => {
    const graph = await inlineScan({
      "A/A.csproj": SDK(),
      "A/Program.cs": "System.Console.WriteLine(1);\n",
      "A/Other.cs": "class O { static void Main() {} }\n",
      "B/B.csproj": SDK(),
      "B/Program.cs": "class P { static void Main() {} }\n",
      "loose/Top.cs": "System.Console.WriteLine(2);\n",
      "loose/Main.cs": "class L { static void Main() {} }\n",
    });
    const mains = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "main").map((node) => node.id);
    assert.ok(!mains.some((id) => id.includes("A/Other.cs")), mains.join("\n"));
    assert.ok(mains.some((id) => id.includes("A/Program.cs")));
    assert.ok(mains.some((id) => id.includes("B/Program.cs")));
    assert.ok(mains.some((id) => id.includes("loose/Top.cs")));
    assert.ok(mains.some((id) => id.includes("loose/Main.cs")));
    assert.equal(runs(graph, projectEntry(graph, "B")!.id).length, 1);
  });
});
