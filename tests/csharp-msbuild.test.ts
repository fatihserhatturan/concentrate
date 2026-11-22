import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { interpretMsbuild } from "../src/integrations/languages/csharp/project/msbuild.js";
import { readCSharpProjectModel, clearCSharpProjectModelCache } from "../src/integrations/languages/csharp/project/index.js";
import { readdir } from "node:fs/promises";

async function walkFiles(root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkFiles(root, rel)));
    else out.push(rel);
  }
  return out;
}

function run(texts: Record<string, string>, extraFiles: string[] = []) {
  const map = new Map(Object.entries(texts));
  return interpretMsbuild({ files: new Set([...map.keys(), ...extraFiles]), texts: map });
}

function one(csproj: string, others: Record<string, string> = {}, extraFiles: string[] = []) {
  const result = run({ "App/App.csproj": csproj, ...others }, extraFiles);
  assert.equal(result.projects.length, 1);
  return result.projects[0]!;
}

describe("interpretMsbuild: project basics", () => {
  it("reads an SDK project", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><RootNamespace>My.App</RootNamespace>
    <AssemblyName>myapp</AssemblyName><Nullable>enable</Nullable><LangVersion>12.0</LangVersion>
  </PropertyGroup>
</Project>`);
    assert.equal(p.name, "App");
    assert.equal(p.dir, "App");
    assert.equal(p.sdk, "Microsoft.NET.Sdk");
    assert.equal(p.outputType, "Exe");
    assert.equal(p.executable, true);
    assert.equal(p.rootNamespace, "My.App");
    assert.equal(p.assemblyName, "myapp");
    assert.deepEqual(p.targetFrameworks, ["net8.0"]);
    assert.equal(p.implicitUsings, false);
    assert.deepEqual(p.usings, []);
    assert.equal(p.unresolved, 0);
    assert.equal(p.line, 1);
    assert.deepEqual(p.solutions, []);
    assert.deepEqual(
      p.config.map((c) => `${c.key}=${c.value}`),
      ["Sdk=Microsoft.NET.Sdk", "TargetFramework=net8.0", "OutputType=Exe", "RootNamespace=My.App", "AssemblyName=myapp", "LangVersion=12.0", "Nullable=enable"],
    );
  });

  it("defaults: Library, project name, no frameworks", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"></Project>`);
    assert.equal(p.outputType, "Library");
    assert.equal(p.executable, false);
    assert.equal(p.rootNamespace, "App");
    assert.equal(p.assemblyName, "App");
    assert.deepEqual(p.targetFrameworks, []);
  });

  it("detects the SDK in the three spellings", () => {
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk.Web/8.0.1"/>`).sdk, "Microsoft.NET.Sdk.Web");
    assert.equal(one(`<Project><Sdk Name="Microsoft.NET.Sdk.Worker" /><PropertyGroup/></Project>`).sdk, "Microsoft.NET.Sdk.Worker");
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk;Other.Sdk"/>`).sdk, "Microsoft.NET.Sdk");
    assert.equal(one(`<Project><Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk.Razor" /></Project>`).sdk, "Microsoft.NET.Sdk.Razor");
  });

  it("Web and Worker SDK projects are executable unless OutputType is Library", () => {
    const web = one(`<Project Sdk="Microsoft.NET.Sdk.Web"/>`);
    assert.equal(web.executable, true);
    assert.equal(web.outputType, "Exe");
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk.Worker"/>`).executable, true);
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>`).executable, false);
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>`).executable, true);
  });

  it("splits TargetFrameworks", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net8.0; net6.0;netstandard2.0</TargetFrameworks></PropertyGroup></Project>`);
    assert.deepEqual(p.targetFrameworks, ["net8.0", "net6.0", "netstandard2.0"]);
  });

  it("reads a legacy non-SDK project", () => {
    const p = one(`<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" Condition="Exists('$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props')" />
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <RootNamespace>Legacy.Lib</RootNamespace>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="System" />
    <ProjectReference Include="..\\Other\\Other.csproj" />
  </ItemGroup>
  <Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />
</Project>`, {}, ["Other/Other.csproj"]);
    assert.equal(p.sdk, null);
    assert.equal(p.rootNamespace, "Legacy.Lib");
    assert.deepEqual(p.targetFrameworks, ["v4.7.2"]);
    assert.deepEqual(p.projectReferences, ["Other/Other.csproj"]);
    assert.equal(p.unresolved, 0);
    assert.equal(p.implicitUsings, false);
  });

  it("keeps a project whose XML is broken and counts it", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><RootNamespace>Broken</RootNamespace>`);
    assert.equal(p.rootNamespace, "Broken");
    assert.ok(p.unresolved >= 1);
  });

  it("handles empty or non-project files", () => {
    const p = one("");
    assert.equal(p.sdk, null);
    assert.equal(p.unresolved, 1);
  });

  it("is case-insensitive for property names", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><targetframework>net8.0</targetframework></PropertyGroup></Project>`);
    assert.deepEqual(p.targetFrameworks, ["net8.0"]);
  });

  it("sorts projects by file and reports interpreted files", () => {
    const result = run({ "b/B.csproj": "<Project/>", "a/A.csproj": "<Project/>", "Directory.Build.props": "<Project/>", "other.props": "<Project/>" });
    assert.deepEqual(result.projects.map((p) => p.file), ["a/A.csproj", "b/B.csproj"]);
    assert.deepEqual(result.files, ["Directory.Build.props", "a/A.csproj", "b/B.csproj"]);
  });
});

describe("interpretMsbuild: properties", () => {
  it("expands properties, later definitions win", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
  <Base>Acme</Base><RootNamespace>$(Base).App</RootNamespace><Base>Other</Base><AssemblyName>$(Base).$(MSBuildProjectName)</AssemblyName>
</PropertyGroup></Project>`);
    assert.equal(p.rootNamespace, "Acme.App");
    assert.equal(p.assemblyName, "Other.App");
    assert.equal(p.unresolved, 0);
  });

  it("unknown properties and property functions count as unresolved", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
  <A>$(Nope)</A><B>$([System.DateTime]::Now.Year)</B><C>$(HOME)</C><D>$(SolutionDir)x</D><E>$(Nope) $(Nope)</E>
</PropertyGroup></Project>`);
    assert.equal(p.unresolved, 6);
  });

  it("a self reference (DefineConstants append) is not unresolved", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><DefineConstants>$(DefineConstants);FOO</DefineConstants></PropertyGroup></Project>`);
    assert.equal(p.unresolved, 0);
  });

  it("applies the default-if-empty condition pattern", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
  <Nullable>enable</Nullable><Nullable Condition="'$(Nullable)' == ''">disable</Nullable>
  <LangVersion Condition="'$(LangVersion)' == ''">11.0</LangVersion>
</PropertyGroup></Project>`);
    assert.deepEqual(p.config.filter((c) => c.key === "Nullable" || c.key === "LangVersion"), [
      { key: "LangVersion", value: "11.0" },
      { key: "Nullable", value: "enable" },
    ]);
  });

  it("built-in directory properties", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
  <ProjectReference Include="$(MSBuildProjectDirectory)/../Lib/Lib.csproj" />
  <ProjectReference Include="$(MSBuildThisFileDirectory)../Lib2/Lib2.csproj" />
</ItemGroup></Project>`, {}, ["Lib/Lib.csproj", "Lib2/Lib2.csproj"]);
    assert.deepEqual(p.projectReferences, ["Lib/Lib.csproj", "Lib2/Lib2.csproj"]);
    assert.equal(p.unresolved, 0);
  });
});

describe("interpretMsbuild: usings", () => {
  it("adds the SDK implicit usings only when ImplicitUsings is enabled", () => {
    const enabled = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>`);
    assert.equal(enabled.implicitUsings, true);
    assert.equal(enabled.usings.length, 7);
    assert.ok(enabled.usings.some((u) => u.namespace === "System.Linq"));
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>true</ImplicitUsings></PropertyGroup></Project>`).implicitUsings, true);
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>`).usings.length, 0);
    const web = one(`<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>`);
    assert.ok(web.usings.some((u) => u.namespace === "Microsoft.AspNetCore.Builder"));
  });

  it("applies Using Include / Static / Alias / Remove in order", () => {
    const p = one(
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>
  <ItemGroup>
    <Using Include="Acme.Core;Acme.Util" />
    <Using Include="System.Math" Static="true" />
    <Using Include="System.Collections.Generic" Alias="Coll" />
    <Using Remove="System.Threading" />
    <Using Remove="Acme.Util" />
  </ItemGroup>
</Project>`,
      { "Directory.Build.props": `<Project><ItemGroup><Using Include="Props.Ns" /><Using Include="System.Net.Http" Alias="H" /></ItemGroup></Project>` },
    );
    const ns = p.usings.map((u) => `${u.static ? "static " : ""}${u.alias ? `${u.alias}=` : ""}${u.namespace}`);
    assert.ok(!ns.includes("System.Threading"));
    assert.ok(!ns.includes("Acme.Util"));
    assert.ok(ns.includes("Acme.Core"));
    assert.ok(ns.includes("static System.Math"));
    assert.ok(ns.includes("Coll=System.Collections.Generic"));
    assert.ok(ns.includes("System.Collections.Generic"));
    assert.ok(ns.includes("Props.Ns"));
    assert.ok(ns.includes("H=System.Net.Http"));
    // implicit set first, then props, then project
    assert.ok(ns.indexOf("System") < ns.indexOf("Props.Ns"));
    assert.ok(ns.indexOf("Props.Ns") < ns.indexOf("Acme.Core"));
  });

  it("ImplicitUsings from Directory.Build.props applies, project can override", () => {
    const props = { "Directory.Build.props": `<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>` };
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"/>`, props).usings.length, 7);
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>`, props).usings.length, 0);
  });
});

describe("interpretMsbuild: references", () => {
  it("resolves ProjectReference with backslashes, counts missing ones", () => {
    const result = run(
      {
        "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
  <ProjectReference Include="..\\Lib\\Lib.csproj" />
  <ProjectReference Include="..\\Lib\\Lib.csproj" />
  <ProjectReference Include="..\\Gone\\Gone.csproj" />
  <ProjectReference Include="..\\..\\..\\Escape.csproj" />
  <ProjectReference Include="..\\Native\\Native.vcxproj" />
</ItemGroup></Project>`,
        "src/Lib/Lib.csproj": `<Project Sdk="Microsoft.NET.Sdk"/>`,
      },
      ["src/Native/Native.vcxproj"],
    );
    const app = result.projects.find((p) => p.name === "App")!;
    assert.deepEqual(app.projectReferences, ["src/Lib/Lib.csproj"]);
    assert.equal(app.unresolved, 2);
    assert.equal(result.unresolved, 2);
  });

  it("reads PackageReference Include / Update / Remove with Version attribute or child", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><V>2.0.0</V></PropertyGroup><ItemGroup>
  <PackageReference Include="A" Version="1.0.0" />
  <PackageReference Include="B"><Version>$(V)</Version></PackageReference>
  <PackageReference Include="C" />
  <PackageReference Update="A" Version="1.5.0" />
  <PackageReference Include="D" Version="3" />
  <PackageReference Remove="D" />
  <PackageReference Include="E" Version="1.0" VersionOverride="9.9" />
</ItemGroup></Project>`);
    assert.deepEqual(p.packageReferences, [
      { name: "A", version: "1.5.0" },
      { name: "B", version: "2.0.0" },
      { name: "C", version: null },
      { name: "E", version: "9.9" },
    ]);
  });

  it("takes central versions from the nearest Directory.Packages.props", () => {
    const result = run({
      "Directory.Packages.props": `<Project><PropertyGroup><XV>2.7.0</XV></PropertyGroup><ItemGroup>
  <PackageVersion Include="xunit" Version="$(XV)" /><PackageVersion Include="Root.Only" Version="1.0.0" /></ItemGroup></Project>`,
      "sub/Directory.Packages.props": `<Project><ItemGroup><PackageVersion Include="xunit" Version="9.0.0" /></ItemGroup></Project>`,
      "sub/Tests/Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" /><PackageReference Include="Root.Only" /></ItemGroup></Project>`,
      "Top/Top.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" /></ItemGroup></Project>`,
    });
    const tests = result.projects.find((p) => p.name === "Tests")!;
    assert.deepEqual(tests.packageReferences, [{ name: "xunit", version: "9.0.0" }, { name: "Root.Only", version: null }]);
    assert.deepEqual(tests.importedProps, ["sub/Directory.Packages.props"]);
    const top = result.projects.find((p) => p.name === "Top")!;
    assert.deepEqual(top.packageReferences, [{ name: "xunit", version: "2.7.0" }]);
    assert.deepEqual(top.importedProps, ["Directory.Packages.props"]);
  });

  it("isTestProject: property or well-known packages", () => {
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>`).isTestProject, true);
    for (const pkg of ["Microsoft.NET.Test.Sdk", "xunit", "NUnit", "MSTest.TestFramework"]) {
      assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="${pkg}" Version="1"/></ItemGroup></Project>`).isTestProject, true, pkg);
    }
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="1"/></ItemGroup></Project>`).isTestProject, false);
    assert.equal(one(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>`).isTestProject, false);
  });
});

describe("interpretMsbuild: Directory.Build.props", () => {
  it("only the nearest Directory.Build.props is auto-imported", () => {
    const result = run({
      "Directory.Build.props": `<Project><PropertyGroup><Nullable>enable</Nullable><LangVersion>9</LangVersion></PropertyGroup></Project>`,
      "src/Directory.Build.props": `<Project><PropertyGroup><LangVersion>10</LangVersion></PropertyGroup></Project>`,
      "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk"/>`,
    });
    const p = result.projects[0]!;
    assert.deepEqual(p.importedProps, ["src/Directory.Build.props"]);
    assert.deepEqual(p.config, [{ key: "Sdk", value: "Microsoft.NET.Sdk" }, { key: "LangVersion", value: "10" }]);
  });

  it("chains to the parent through GetPathOfFileAbove, parent first", () => {
    const result = run({
      "Directory.Build.props": `<Project><PropertyGroup><Nullable>enable</Nullable><LangVersion>9</LangVersion></PropertyGroup><ItemGroup><Using Include="Root.Ns"/></ItemGroup></Project>`,
      "src/Directory.Build.props": `<Project>
  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />
  <PropertyGroup><LangVersion>10</LangVersion></PropertyGroup><ItemGroup><Using Include="Src.Ns"/></ItemGroup>
</Project>`,
      "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk"/>`,
    });
    const p = result.projects[0]!;
    assert.deepEqual(p.importedProps, ["src/Directory.Build.props", "Directory.Build.props"]);
    assert.deepEqual(p.config.map((c) => `${c.key}=${c.value}`), ["Sdk=Microsoft.NET.Sdk", "LangVersion=10", "Nullable=enable"]);
    assert.deepEqual(p.usings.map((u) => u.namespace), ["Root.Ns", "Src.Ns"]);
    assert.equal(p.unresolved, 0);
  });

  it("a missing parent with a Condition is silent, without one it is unresolved", () => {
    const import1 = `<Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />`;
    const silent = run({ "Directory.Build.props": `<Project>${import1.replace("/>", `Condition="'$(X)' == '' And Exists('a')" />`)}</Project>`, "A/A.csproj": "<Project/>" });
    assert.equal(silent.projects[0]!.unresolved, 0);
    const loud = run({ "Directory.Build.props": `<Project>${import1}</Project>`, "A/A.csproj": "<Project/>" });
    assert.equal(loud.projects[0]!.unresolved, 1);
  });

  it("follows a relative Import of a props file and counts a missing one", () => {
    const result = run({
      "Directory.Build.props": `<Project><Import Project="build/common.props" /><Import Project="build/missing.props" /></Project>`,
      "build/common.props": `<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>`,
      "A/A.csproj": `<Project Sdk="Microsoft.NET.Sdk"/>`,
    });
    const p = result.projects[0]!;
    assert.ok(p.config.some((c) => c.key === "Nullable"));
    assert.equal(p.unresolved, 1);
    assert.deepEqual(p.importedProps, ["Directory.Build.props", "build/common.props"]);
  });

  it("survives an import cycle", () => {
    const result = run({
      "Directory.Build.props": `<Project><Import Project="a.props" /></Project>`,
      "a.props": `<Project><Import Project="Directory.Build.props" /><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>`,
      "A/A.csproj": `<Project Sdk="Microsoft.NET.Sdk"/>`,
    });
    assert.ok(result.projects[0]!.config.some((c) => c.key === "Nullable"));
  });

  it("a property in the props file can use the project's built-ins", () => {
    const p = one(`<Project Sdk="Microsoft.NET.Sdk"/>`, { "Directory.Build.props": `<Project><PropertyGroup><RootNamespace>Acme.$(MSBuildProjectName)</RootNamespace></PropertyGroup></Project>` });
    assert.equal(p.rootNamespace, "Acme.App");
  });
});

describe("interpretMsbuild: performance", () => {
  it("handles many projects sharing props quickly", () => {
    const texts: Record<string, string> = {
      "Directory.Build.props": `<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>`,
      "Directory.Packages.props": `<Project><ItemGroup>${Array.from({ length: 200 }, (_, i) => `<PackageVersion Include="P${i}" Version="1.0.${i}" />`).join("")}</ItemGroup></Project>`,
    };
    for (let i = 0; i < 500; i += 1) texts[`src/p${i}/deep/P${i}.csproj`] = `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="P${i % 200}" /></ItemGroup></Project>`;
    const start = Date.now();
    const result = run(texts);
    assert.equal(result.projects.length, 500);
    assert.equal(result.projects[0]!.packageReferences[0]!.version !== null, true);
    assert.ok(Date.now() - start < 5000);
  });
});

describe("readCSharpProjectModel on fixtures/csharp-solution", () => {
  it("matches the README facts", async () => {
    clearCSharpProjectModelCache();
    const root = path.resolve("fixtures/csharp-solution");
    const files = await walkFiles(root);
    const model = await readCSharpProjectModel(root, files);
    const by = new Map(model.projects.map((p) => [p.file, p]));
    assert.deepEqual([...by.keys()].sort(), [
      "src/Shop.Core/Shop.Core.csproj",
      "src/Shop.Data/Shop.Data.csproj",
      "src/Shop.Web/Shop.Web.csproj",
      "tests/Shop.Tests/Shop.Tests.csproj",
      "tools/Orphan/Orphan.csproj",
    ]);
    const core = by.get("src/Shop.Core/Shop.Core.csproj")!;
    const data = by.get("src/Shop.Data/Shop.Data.csproj")!;
    const web = by.get("src/Shop.Web/Shop.Web.csproj")!;
    const tests = by.get("tests/Shop.Tests/Shop.Tests.csproj")!;
    const orphan = by.get("tools/Orphan/Orphan.csproj")!;

    assert.equal(core.sdk, "Microsoft.NET.Sdk");
    assert.equal(core.executable, false);
    assert.deepEqual(core.targetFrameworks, ["net8.0"]);
    assert.deepEqual(core.projectReferences, []);
    assert.equal(core.rootNamespace, "Shop.Core");

    assert.deepEqual(data.targetFrameworks, ["net8.0", "net6.0"]);
    assert.deepEqual(data.projectReferences, ["src/Shop.Core/Shop.Core.csproj"]);
    assert.deepEqual(data.packageReferences, [
      { name: "Microsoft.EntityFrameworkCore", version: "8.0.4" },
      { name: "Microsoft.EntityFrameworkCore.Sqlite", version: "8.0.4" },
    ]);

    assert.equal(web.sdk, "Microsoft.NET.Sdk.Web");
    assert.equal(web.executable, true);
    assert.deepEqual(web.projectReferences, ["src/Shop.Core/Shop.Core.csproj", "src/Shop.Data/Shop.Data.csproj"]);
    assert.equal(web.unresolved, 2);

    assert.equal(tests.isTestProject, true);
    assert.deepEqual(tests.projectReferences, ["src/Shop.Core/Shop.Core.csproj"]);
    assert.deepEqual(tests.packageReferences, [
      { name: "Microsoft.NET.Test.Sdk", version: "17.9.0" },
      { name: "xunit", version: "2.7.0" },
      { name: "xunit.runner.visualstudio", version: "2.5.7" },
    ]);
    assert.ok(tests.usings.some((u) => u.namespace === "Xunit"));

    assert.equal(orphan.executable, true);
    assert.equal(orphan.outputType, "Exe");

    for (const project of model.projects) {
      assert.deepEqual(project.importedProps, ["Directory.Build.props", "Directory.Packages.props"], project.file);
      assert.equal(project.implicitUsings, true);
      assert.ok(project.usings.some((u) => u.namespace === "System.Diagnostics"));
      assert.ok(project.config.some((c) => c.key === "Nullable" && c.value === "enable"));
      assert.ok(project.config.some((c) => c.key === "LangVersion" && c.value === "12.0"));
      if (project !== web) assert.equal(project.unresolved, 0, project.file);
    }
    assert.ok(web.usings.some((u) => u.namespace === "Microsoft.AspNetCore.Builder"));
    assert.ok(!core.usings.some((u) => u.namespace === "Microsoft.AspNetCore.Builder"));
  });
});
