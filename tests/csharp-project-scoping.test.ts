import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { BuildCodeGraphResult } from "../src/core/scan/result.js";
import type { IGraphContributor } from "../src/core/contracts/graph-contributor.js";
import { buildCSharpNamespaceIndex, csharpUsingIndexOf } from "../src/integrations/languages/csharp/namespaces.js";
import { setCSharpProjectModel } from "../src/integrations/languages/csharp/project.js";

// Phase 45 track D: usings and namespace visibility are scoped to projects. A file resolves namespaces and types only
// inside its own project and the projects it references (transitively); `global using`s and the project model's
// usings (SDK implicit, `<Using Include>`) apply per project; files in no project keep the Phase 44 behavior.

const strip = (id: string): string => id.replace(/^file:/u, "");
const csproj = (refs: string[] = []): string =>
  `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n${refs.length ? `  <ItemGroup>\n${refs.map((ref) => `    <ProjectReference Include="${ref}" />`).join("\n")}\n  </ItemGroup>\n` : ""}</Project>\n`;

async function scanFiles(files: Record<string, string>): Promise<BuildCodeGraphResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cs-scoping-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
    return await buildCodeGraph(dir, { continueOnError: true, concurrency: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// `Derived -> Base` pairs of EXTENDS / IMPLEMENTS edges (qualified names).
const hierarchy = (result: BuildCodeGraphResult): string[] =>
  result.relationships
    .filter((rel) => rel.type === "EXTENDS" || rel.type === "IMPLEMENTS")
    .map((rel) => `${/:(?:class|interface):\d+:(.*)$/u.exec(rel.from)?.[1]} -> ${/:(?:class|interface):\d+:(.*)$/u.exec(rel.to)?.[1]}`)
    .sort();

const resolvesTo = (result: BuildCodeGraphResult, file: string, source: string): string[] => {
  const node = result.nodes.find((n) => n.label === "Import" && n.id.startsWith(`file:${file}:import:`) && n.properties.source === source);
  assert.ok(node, `${source} in ${file}`);
  return result.relationships.filter((rel) => rel.type === "RESOLVES_TO" && rel.from === node.id).map((rel) => strip(rel.to)).sort();
};

describe("C# project scoping (fixtures/csharp-solution)", () => {
  it("keeps Shop.Data's global using out of Shop.Core and resolves what each project references", async () => {
    const result = await buildCodeGraph(path.resolve("fixtures", "csharp-solution"), { continueOnError: true, concurrency: 2 });

    // Acceptance: `OrderRecord` (Shop.Data.Models) stays unresolved in Shop.Core: no edge of SalesReport reaches OrderRecord.cs.
    const record = "src/Shop.Data/Models/OrderRecord.cs";
    const reaching = result.relationships.filter((rel) => strip(rel.from).startsWith("src/Shop.Core/") && strip(rel.to).includes(record));
    assert.deepEqual(reaching, []);
    // ... while Shop.Data resolves its own global using.
    assert.ok(result.relationships.some((rel) => rel.type === "RESOLVES_TO" && strip(rel.from).startsWith("src/Shop.Data/GlobalUsings.cs:import") && strip(rel.to) === record));
    // Shop.Core's own global using reaches its own files.
    assert.ok(result.relationships.some((rel) => rel.type === "RESOLVES_TO" && strip(rel.from).startsWith("src/Shop.Core/GlobalUsings.cs:import") && strip(rel.to) === "src/Shop.Core/Abstractions/IClock.cs"));

    // Web resolves Core and Data, Tests resolves Core.
    assert.deepEqual(resolvesTo(result, "src/Shop.Web/Services/CheckoutService.cs", "Shop.Core.Domain"), ["src/Shop.Core/Domain/Order.cs"]);
    assert.deepEqual(resolvesTo(result, "src/Shop.Web/Services/CheckoutService.cs", "Shop.Data.Repositories"), ["src/Shop.Data/Repositories/OrderRepository.cs"]);
    assert.deepEqual(resolvesTo(result, "tests/Shop.Tests/OrderTests.cs", "Shop.Core.Domain"), ["src/Shop.Core/Domain/Order.cs"]);
    assert.ok(hierarchy(result).includes("Shop.Tests.OrderTests.FixedClock -> Shop.Core.Abstractions.IClock"));
    const calls = result.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO").map((rel) => `${/:function:\d+:(.*?):call:/u.exec(rel.from)?.[1]} -> ${strip(rel.to).split(":")[0]}`);
    assert.ok(calls.includes("Shop.Web.Services.CheckoutService.PlaceAsync -> src/Shop.Data/Repositories/OrderRepository.cs"));
    assert.ok(calls.includes("Shop.Web.Services.CheckoutService.PlaceAsync -> src/Shop.Core/Domain/Order.cs"));
    assert.ok(calls.includes("Shop.Tests.OrderTests.TotalSumsLines -> src/Shop.Core/Domain/Order.cs"));
    // SDK implicit usings and Directory.Build.props `<Using>` name System namespaces: external, never counted.
    assert.equal(result.report.unresolvedRelativeImports, 0);
  });
});

describe("C# project scoping (inline projects)", () => {
  const base = {
    "src/A/A.csproj": csproj(),
    "src/A/Types.cs": "namespace A;\npublic class Base {}\n",
    "src/B/B.csproj": csproj(["../A/A.csproj"]),
  };

  it("resolves namespaces only in the project and its references, and counts the rest as unresolved", async () => {
    const result = await scanFiles({
      ...base,
      "src/B/Use.cs": "using A;\nnamespace B;\npublic class D : Base {}\n",
      "src/B/Types.cs": "namespace B;\npublic class BBase {}\n",
      // A does not reference B: `using B;` finds nothing and `BBase` stays unresolved.
      "src/A/Use.cs": "using B;\nnamespace A;\npublic class E : BBase {}\n",
    });
    assert.deepEqual(hierarchy(result), ["B.D -> A.Base"]);
    assert.deepEqual(resolvesTo(result, "src/B/Use.cs", "A"), ["src/A/Types.cs", "src/A/Use.cs"]);
    assert.deepEqual(resolvesTo(result, "src/A/Use.cs", "B"), []);
    assert.equal(result.report.unresolvedRelativeImports, 1);
  });

  it("follows ProjectReferences transitively", async () => {
    const result = await scanFiles({
      ...base,
      "src/C/C.csproj": csproj(["../B/B.csproj"]),
      "src/B/Types.cs": "namespace B;\npublic class BBase {}\n",
      "src/C/Use.cs": "using A;\nusing B;\nnamespace C;\npublic class X : Base {}\npublic class Y : BBase {}\n",
    });
    assert.deepEqual(hierarchy(result), ["C.X -> A.Base", "C.Y -> B.BBase"]);
    assert.equal(result.report.unresolvedRelativeImports, 0);
  });

  it("applies a global using to its own project only", async () => {
    const result = await scanFiles({
      ...base,
      "src/B/GlobalUsings.cs": "global using A;\n",
      "src/B/Use.cs": "namespace B;\npublic class D : Base {}\n",
      // Another project that references A but never imports it: B's global using does not reach it.
      "src/C/C.csproj": csproj(["../A/A.csproj"]),
      "src/C/Use.cs": "namespace C;\npublic class F : Base {}\n",
    });
    assert.deepEqual(hierarchy(result), ["B.D -> A.Base"]);
  });

  it("keeps a global using of a project-less file out of the projects, and project-less files unchanged", async () => {
    const result = await scanFiles({
      ...base,
      "loose/GlobalUsings.cs": "global using A;\n",
      "loose/Use.cs": "namespace Loose;\npublic class L : Base {}\n",
      "src/B/Use.cs": "namespace B;\npublic class D : Base {}\n",
    });
    // Project-less files see everything, with their own global using; the project file gets nothing from it.
    assert.deepEqual(hierarchy(result), ["Loose.L -> A.Base"]);
  });

  it("scans without any project file exactly as before", async () => {
    const result = await scanFiles({
      "GlobalUsings.cs": "global using A;\n",
      "a/Types.cs": "namespace A;\npublic class Base {}\n",
      "b/Use.cs": "namespace B;\npublic class D : Base {}\n",
    });
    assert.deepEqual(hierarchy(result), ["B.D -> A.Base"]);
  });

  it("sees only the visible projects' part of a namespace declared in several projects", async () => {
    const result = await scanFiles({
      "src/Core/Core.csproj": csproj(),
      "src/Core/Thing.cs": "namespace Shop.Core;\npublic class Thing {}\n",
      "src/Core/Uses.cs": "namespace Shop.Core;\npublic class FromCore : Helper {}\npublic class CoreOk : Thing {}\n",
      "tests/T/T.csproj": csproj(["../../src/Core/Core.csproj"]),
      "tests/T/Helper.cs": "namespace Shop.Core;\npublic class Helper {}\n",
      "tests/T/Uses.cs": "namespace Shop.Core;\npublic class FromTests : Helper {}\npublic class TestsOk : Thing {}\n",
    });
    // Core never sees the test project's `Helper`; the test project sees both parts of `Shop.Core`.
    assert.deepEqual(hierarchy(result), ["Shop.Core.CoreOk -> Shop.Core.Thing", "Shop.Core.FromTests -> Shop.Core.Helper", "Shop.Core.TestsOk -> Shop.Core.Thing"]);
  });

  it("applies <Using Include> from Directory.Build.props to every project it covers", async () => {
    const result = await scanFiles({
      ...base,
      "Directory.Build.props": '<Project>\n  <ItemGroup>\n    <Using Include="A" />\n  </ItemGroup>\n</Project>\n',
      "src/B/Use.cs": "namespace B;\npublic class D : Base {}\n",
    });
    assert.deepEqual(hierarchy(result), ["B.D -> A.Base"]);
  });

  it("does not let an SDK implicit using leak a project-only namespace into an unreferencing project", async () => {
    const result = await scanFiles({
      "src/A/A.csproj": csproj(),
      "src/A/Types.cs": "namespace A;\npublic class Base {}\n",
      "src/B/B.csproj": '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>\n</Project>\n',
      "src/B/Use.cs": "using System;\nnamespace B;\npublic class D : Base {}\n",
    });
    assert.deepEqual(hierarchy(result), []);
    assert.equal(result.report.unresolvedRelativeImports, 0);
  });
});

// F2: a project with unresolved ProjectReferences sees everything; ownership follows the declared (first-per-directory) project.
describe("csharp project scoping: unresolved references and ownership", () => {
  const project = (file: string, extra: Record<string, unknown> = {}): unknown => {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    return { name: path.basename(file, ".csproj"), file, dir, projectReferences: [], usings: [], ...extra };
  };
  const build = (projects: unknown[], files: Record<string, string[]>) => {
    const nodes = Object.entries(files).map(([relativePath, namespaces]) => ({
      id: `file:${relativePath}`,
      label: "File",
      properties: { language: "csharp", relativePath, csharpNamespaces: JSON.stringify(namespaces) },
    }));
    const graph = {
      nodes,
      relationships: [],
      node: (id: string) => nodes.find((n) => n.id === id),
      nodesWithLabel: (label: string) => (label === "File" ? nodes : []),
      relationshipsOfType: () => [],
    } as unknown as IGraphContributor;
    setCSharpProjectModel(graph, { projects, solutions: [], files: [], unresolved: 0 } as never);
    return buildCSharpNamespaceIndex(graph);
  };
  const files = { "a/Types.cs": ["A"], "b/Use.cs": ["B"] };

  it("scopes a project without references and shows everything to one with unresolved references", () => {
    const scoped = csharpUsingIndexOf(build([project("a/A.csproj"), project("b/B.csproj")], files))!;
    assert.equal(scoped.canSee("file:b/Use.cs", "file:a/Types.cs"), false);
    assert.equal(scoped.hasNamespaceFor("file:b/Use.cs", "A"), false);
    const open = csharpUsingIndexOf(build([project("a/A.csproj"), project("b/B.csproj", { unresolvedReferences: 1 })], files))!;
    assert.equal(open.canSee("file:b/Use.cs", "file:a/Types.cs"), true);
    assert.equal(open.hasNamespaceFor("file:b/Use.cs", "A"), true);
    assert.equal(open.resolveUsing({ source: "A", kind: "normal", scope: "" }, "file:b/Use.cs").targetKind, "namespace");
    // Only the viewer's own flag counts: A (unflagged) still does not see B.
    assert.equal(open.canSee("file:a/Types.cs", "file:b/Use.cs"), false);
  });

  it("assigns files to the project the manifest declares when several share a directory", () => {
    const index = csharpUsingIndexOf(build([project("x/Z.csproj"), project("x/A.csproj"), project("y/Y.csproj", { projectReferences: ["x/Z.csproj"] })], { "x/F.cs": ["X"], "y/G.cs": ["Y"] }))!;
    // x/A.csproj owns directory x (code-unit order); Y's reference to x/Z.csproj stands for that owner.
    assert.equal(index.canSee("file:y/G.cs", "file:x/F.cs"), true);
    assert.equal(index.canSee("file:x/F.cs", "file:y/G.cs"), false);
  });
});
