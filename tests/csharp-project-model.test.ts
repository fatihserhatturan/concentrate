import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SDK_IMPLICIT_USINGS,
  emptyCSharpProjectModel,
  implicitUsingsOfSdk,
  isCSharpBuildFile,
  isCSharpProjectFile,
  isCSharpSolutionFile,
  isMsbuildPropsFile,
  projectOfFile,
  readCSharpProjectModel,
  visibleProjects,
  type CSharpProject,
  type CSharpProjectModel,
} from "../src/integrations/languages/csharp/project/index.js";

function project(file: string, projectReferences: string[] = []): CSharpProject {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.csproj$/u, "");
  return {
    name, file, dir, sdk: "Microsoft.NET.Sdk", outputType: "Library", executable: false, rootNamespace: name, assemblyName: name,
    targetFrameworks: ["net8.0"], implicitUsings: false, usings: [], projectReferences, packageReferences: [], isTestProject: false,
    importedProps: [], solutions: [], config: [], unresolved: 0, line: 1,
  };
}

const model: CSharpProjectModel = {
  ...emptyCSharpProjectModel(),
  projects: [
    project("App.csproj", ["lib/Lib.csproj"]),
    project("lib/Lib.csproj", ["lib/core/Core.csproj"]),
    project("lib/core/Core.csproj"),
    project("tools/Tool.csproj"),
  ],
};

describe("C# project model helpers", () => {
  it("recognizes project, solution and props files", () => {
    assert.ok(isCSharpProjectFile("a/B.csproj") && !isCSharpProjectFile("a/B.cs"));
    assert.ok(isCSharpSolutionFile("S.sln") && isCSharpSolutionFile("S.slnx") && !isCSharpSolutionFile("S.slnf"));
    assert.ok(isMsbuildPropsFile("Directory.Build.props") && !isMsbuildPropsFile("a.targets"));
    assert.ok(isCSharpBuildFile("x/Directory.Packages.props") && isCSharpBuildFile("S.sln") && !isCSharpBuildFile("Program.cs"));
  });

  it("finds the project of a file by the longest directory", () => {
    assert.equal(projectOfFile(model, "lib/core/Thing.cs")?.name, "Core");
    assert.equal(projectOfFile(model, "lib/Other.cs")?.name, "Lib");
    assert.equal(projectOfFile(model, "Program.cs")?.name, "App");
    assert.equal(projectOfFile(model, "tools/x/Y.cs")?.name, "Tool");
    assert.equal(projectOfFile({ ...model, projects: model.projects.slice(1) }, "Program.cs"), undefined);
  });

  it("collects visible projects transitively, tolerating cycles", () => {
    assert.deepEqual([...visibleProjects(model, "App.csproj")].sort(), ["App.csproj", "lib/Lib.csproj", "lib/core/Core.csproj"]);
    assert.deepEqual([...visibleProjects(model, "tools/Tool.csproj")], ["tools/Tool.csproj"]);
    const cyclic: CSharpProjectModel = { ...model, projects: [project("A.csproj", ["B.csproj"]), project("B.csproj", ["A.csproj"])] };
    assert.deepEqual([...visibleProjects(cyclic, "A.csproj")].sort(), ["A.csproj", "B.csproj"]);
  });

  it("knows the SDK implicit usings", () => {
    assert.ok(SDK_IMPLICIT_USINGS["Microsoft.NET.Sdk.Web"]!.includes("Microsoft.AspNetCore.Builder"));
    assert.ok(!SDK_IMPLICIT_USINGS["Microsoft.NET.Sdk"]!.includes("Microsoft.Extensions.Hosting"));
    assert.ok(implicitUsingsOfSdk("Microsoft.NET.Sdk.Worker").includes("Microsoft.Extensions.Hosting"));
    assert.deepEqual(implicitUsingsOfSdk(null), []);
    assert.deepEqual(implicitUsingsOfSdk("Microsoft.NET.Sdk.Razor"), SDK_IMPLICIT_USINGS["Microsoft.NET.Sdk"]);
  });

  it("returns an empty model when there are no build files", async () => {
    assert.deepEqual(await readCSharpProjectModel("/nonexistent", ["a.cs", "b/c.cs"]), emptyCSharpProjectModel());
  });
});
