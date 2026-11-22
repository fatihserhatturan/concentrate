import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { interpretMsbuild } from "../src/integrations/languages/csharp/project/msbuild.js";
import { interpretSolutions } from "../src/integrations/languages/csharp/project/solution.js";
import { isCSharpProjectFile, projectOfFile } from "../src/integrations/languages/csharp/project/index.js";
import { emptyCSharpProjectModel } from "../src/integrations/languages/csharp/project/types.js";
import { declaredCSharpProjects } from "../src/integrations/languages/csharp/manifest.js";

function run(texts: Record<string, string>, extra: string[] = []) {
  const map = new Map(Object.entries(texts));
  return interpretMsbuild({ files: new Set([...map.keys(), ...extra]), texts: map });
}
const find = (result: ReturnType<typeof run>, name: string) => {
  const found = result.projects.find((project) => project.name === name);
  assert.ok(found, name);
  return found;
};
const SDK = `Sdk="Microsoft.NET.Sdk"`;

describe("C# MSBuild: evaluation order", () => {
  it("evaluates properties before items, across files", () => {
    const result = run({
      "Directory.Build.props": `<Project><ItemGroup><PackageReference Include="Foo" Version="$(FooV)"/></ItemGroup></Project>`,
      "A/A.csproj": `<Project ${SDK}><PropertyGroup><FooV>3.1</FooV></PropertyGroup></Project>`,
    });
    assert.deepEqual(find(result, "A").packageReferences, [{ name: "Foo", version: "3.1" }]);
  });

  it("resolves a ProjectReference through a property defined later", () => {
    const result = run({
      "A/A.csproj": `<Project ${SDK}><ItemGroup><ProjectReference Include="$(Dep)"/></ItemGroup><PropertyGroup><Dep>../B/B.csproj</Dep></PropertyGroup></Project>`,
      "B/B.csproj": `<Project ${SDK}/>`,
    });
    assert.deepEqual(find(result, "A").projectReferences, ["B/B.csproj"]);
    assert.equal(find(result, "A").unresolvedReferences, 0);
  });

  it("evaluates Directory.Packages.props in the project's context", () => {
    const result = run({
      "Directory.Build.props": `<Project><PropertyGroup><XV>2.6.0</XV></PropertyGroup></Project>`,
      "Directory.Packages.props": `<Project><ItemGroup><PackageVersion Include="xunit" Version="$(XV)"/><PackageVersion Include="Bar" Version="$(BarV)"/></ItemGroup></Project>`,
      "A/A.csproj": `<Project ${SDK}><PropertyGroup><BarV>9.0</BarV></PropertyGroup><ItemGroup><PackageReference Include="xunit"/><PackageReference Include="Bar"/></ItemGroup></Project>`,
    });
    assert.deepEqual(find(result, "A").packageReferences, [{ name: "xunit", version: "2.6.0" }, { name: "Bar", version: "9.0" }]);
    assert.equal(find(result, "A").unresolved, 0);
  });

  it("honours a default-if-empty Condition on the PropertyGroup", () => {
    const result = run({
      "A/A.csproj": `<Project ${SDK}><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><PropertyGroup Condition="'$(TargetFramework)' == ''"><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>`,
      "B/B.csproj": `<Project ${SDK}><PropertyGroup Condition="'$(TargetFramework)' == ''"><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>`,
    });
    assert.deepEqual(find(result, "A").targetFrameworks, ["net8.0"]);
    assert.deepEqual(find(result, "B").targetFrameworks, ["net6.0"]);
  });

  it("disables the auto-imports with ImportDirectoryBuildProps / ImportDirectoryPackagesProps", () => {
    const result = run({
      "Directory.Build.props": `<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>`,
      "Directory.Packages.props": `<Project><ItemGroup><PackageVersion Include="X" Version="1"/></ItemGroup></Project>`,
      "A/A.csproj": `<Project ${SDK}><PropertyGroup><ImportDirectoryBuildProps>false</ImportDirectoryBuildProps><ImportDirectoryPackagesProps>false</ImportDirectoryPackagesProps></PropertyGroup><ItemGroup><PackageReference Include="X"/></ItemGroup></Project>`,
    });
    const a = find(result, "A");
    assert.deepEqual(a.importedProps, []);
    assert.equal(a.config.some((entry) => entry.key === "Nullable"), false);
    assert.deepEqual(a.packageReferences, [{ name: "X", version: null }]);
  });
});

describe("C# MSBuild: references, names and case", () => {
  it("skips a ProjectReference to itself", () => {
    const result = run({ "A/A.csproj": `<Project ${SDK}><ItemGroup><ProjectReference Include="A.csproj"/></ItemGroup></Project>` });
    assert.deepEqual(find(result, "A").projectReferences, []);
  });

  it("reads upper-case extensions and resolves references that differ only in case", () => {
    assert.equal(isCSharpProjectFile("x/A.CSPROJ"), true);
    const result = run({
      "A/A.CSPROJ": `<Project ${SDK}><ItemGroup><ProjectReference Include="..\\b\\B.csproj"/></ItemGroup></Project>`,
      "B/B.csproj": `<Project ${SDK}/>`,
    });
    assert.deepEqual(result.projects.map((project) => project.name), ["A", "B"]);
    assert.deepEqual(find(result, "A").projectReferences, ["B/B.csproj"]);
  });

  it("resolves solution entries that differ only in case to the scanned path", () => {
    const sln = `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "src\\a\\A.CSPROJ", "{1}"\nEndProject\n`;
    const result = interpretSolutions({ files: new Set(["src/A/A.csproj"]), texts: new Map([["S.sln", sln]]) });
    assert.deepEqual(result.solutions[0]!.projects, ["src/A/A.csproj"]);
    assert.equal(result.unresolved, 0);
  });

  it("counts unexpandable or missing ProjectReferences in unresolvedReferences", () => {
    const result = run({
      "A/A.csproj": `<Project ${SDK}><ItemGroup><ProjectReference Include="$(SolutionDir)B/B.csproj"/><ProjectReference Include="../Nope/N.csproj"/></ItemGroup></Project>`,
      "B/B.csproj": `<Project ${SDK}/>`,
    });
    assert.equal(find(result, "A").unresolvedReferences, 2);
    assert.equal(find(result, "B").unresolvedReferences, 0);
  });

  it("sanitizes the default RootNamespace", () => {
    const result = run({ "x/1st-App.Core/1st-App.Core.csproj": `<Project ${SDK}/>`, "y/Ok/Ok.csproj": `<Project ${SDK}/>` });
    assert.equal(find(result, "1st-App.Core").rootNamespace, "_1st_App.Core");
    assert.equal(find(result, "1st-App.Core").assemblyName, "1st-App.Core");
    assert.equal(find(result, "Ok").rootNamespace, "Ok");
  });

  it("recognizes more test projects and Blazor WebAssembly executables", () => {
    const pkg = (name: string) => `<Project ${SDK}><ItemGroup><PackageReference Include="${name}" Version="1"/></ItemGroup></Project>`;
    const result = run({
      "a/a.csproj": pkg("xunit.v3"),
      "b/b.csproj": pkg("MSTest.TestAdapter"),
      "c/c.csproj": pkg("NUnit3TestAdapter"),
      "d/d.csproj": pkg("xunit.runner.visualstudio"),
      "e/e.csproj": pkg("TUnit"),
      "f/f.csproj": `<Project Sdk="MSTest.Sdk/3.6.0"/>`,
      "g/g.csproj": pkg("Newtonsoft.Json"),
      "w/w.csproj": `<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"/>`,
    });
    for (const name of ["a", "b", "c", "d", "e", "f"]) assert.equal(find(result, name).isTestProject, true, name);
    assert.equal(find(result, "g").isTestProject, false);
    assert.equal(find(result, "w").executable, true);
    assert.equal(find(result, "w").outputType, "Exe");
  });
});

describe("C# projects: ownership and duplicates", () => {
  it("projectOfFile and the manifest agree on the project of a directory", () => {
    const result = run({ "B/B.csproj": `<Project/>`, "B/A.csproj": `<Project/>`, "B/Z.csproj": `<Project/>` });
    const model = { ...emptyCSharpProjectModel(), projects: result.projects };
    assert.equal(projectOfFile(model, "B/x.cs")?.file, "B/A.csproj");
    assert.deepEqual(declaredCSharpProjects(model).map((project) => project.file), ["B/A.csproj"]);
  });

  it("a root project and a one-character directory do not tie", () => {
    const result = run({ "R.csproj": `<Project/>`, "a/A.csproj": `<Project/>` });
    const model = { ...emptyCSharpProjectModel(), projects: result.projects };
    assert.equal(projectOfFile(model, "a/x.cs")?.file, "a/A.csproj");
    assert.equal(projectOfFile(model, "r/x.cs")?.file, "R.csproj");
  });
});

describe("C# projects: fixture graph", () => {
  it("shows packageReferences on the Package node", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-solution"), { continueOnError: false });
    const node = (name: string) => graph.nodes.find((candidate) => candidate.label === "Package" && candidate.properties.name === name);
    const list = (name: string) => JSON.parse(String(node(name)?.properties.packageReferences)) as Array<{ name: string; version: string | null }>;
    assert.ok(list("Shop.Data").length > 0);
    assert.ok(list("Shop.Tests").some((reference) => reference.version !== null));
    assert.ok(list("Shop.Data").every((reference) => typeof reference.name === "string"));
  });
});
