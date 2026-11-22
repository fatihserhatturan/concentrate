import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpretSolutions } from "../src/integrations/languages/csharp/project/solution.js";

const run = (texts: Record<string, string>, files: string[]) =>
  interpretSolutions({ files: new Set(files), texts: new Map(Object.entries(texts)) });

const GUID = "{9A19103F-16F7-4668-BE54-9A1E7A4F7556}";

describe("csharp solution reader", () => {
  it("reads .sln with BOM, CRLF, folders, non-csproj entries and spaces", () => {
    const text =
      "﻿\r\nMicrosoft Visual Studio Solution File, Format Version 12.00\r\n" +
      `Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{1}"\r\nEndProject\r\n` +
      `Project("${GUID}") = "My App", "My App\\My App.csproj", "{2}"\r\nEndProject\r\n` +
      `Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Cpp", "Cpp\\Cpp.vcxproj", "{3}"\r\nEndProject\r\n` +
      `Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "Fs", "Fs\\Fs.fsproj", "{4}"\r\nEndProject\r\n` +
      `Project("${GUID}") = "Up", "..\\Other\\Other.csproj", "{5}"\r\nEndProject\r\n` +
      `Project("${GUID}") = "Gone", "Gone\\Gone.csproj", "{6}"\r\nEndProject\r\n` +
      `Global\r\n\tGlobalSection(X) = preSolution\r\n\t\tProject("${GUID}") = "Fake", "Fake\\Fake.csproj", "{7}"\r\n\tEndGlobalSection\r\nEndGlobal\r\n`;
    const result = run({ "sub/A.sln": text }, ["sub/My App/My App.csproj", "Other/Other.csproj"]);
    // `..\Other` from `sub/` lands on `Other/Other.csproj`; `Gone` is missing.
    assert.deepEqual(result.solutions, [
      { file: "sub/A.sln", format: "sln", projects: ["Other/Other.csproj", "sub/My App/My App.csproj"], unresolved: 1 },
    ]);
    assert.equal(result.unresolved, 1);
  });

  it("treats paths leaving the scan root as unresolved", () => {
    const text = `Project("${GUID}") = "Up", "..\\X\\X.csproj", "{5}"\nEndProject\n`;
    assert.equal(run({ "A.sln": text }, ["X/X.csproj"]).unresolved, 1);
  });

  it("reads .slnx projects at any depth", () => {
    const text = `<Solution>
  <Project Path="Root.csproj" />
  <Folder Name="/a/"><Folder Name="/a/b/"><Project Path="a\\B\\B.csproj" /></Folder></Folder>
  <Project Path="native/N.vcxproj" />
  <Project Path="missing/M.csproj" />
</Solution>`;
    const result = run({ "d/S.slnx": text }, ["d/Root.csproj", "d/a/B/B.csproj"]);
    assert.deepEqual(result.solutions, [
      { file: "d/S.slnx", format: "slnx", projects: ["d/Root.csproj", "d/a/B/B.csproj"], unresolved: 1 },
    ]);
  });

  it("sorts solutions by file and survives malformed input", () => {
    const result = run({ "b.sln": "garbage", "a.slnx": "<Solution><Project Path=" }, []);
    assert.deepEqual(result.solutions.map((s) => s.file), ["a.slnx", "b.sln"]);
    assert.equal(result.unresolved, 0);
  });

  it("reads the csharp-solution fixture", () => {
    const files = [
      "src/Shop.Core/Shop.Core.csproj",
      "src/Shop.Data/Shop.Data.csproj",
      "src/Shop.Web/Shop.Web.csproj",
      "tests/Shop.Tests/Shop.Tests.csproj",
      "tools/Orphan/Orphan.csproj",
    ];
    const read = (name: string) => readFileSync(`fixtures/csharp-solution/${name}`, "utf8");
    const result = run({ "Shop.sln": read("Shop.sln"), "Shop.slnx": read("Shop.slnx") }, files);
    const expected = files.slice(0, 4).sort();
    assert.deepEqual(result.solutions.map((s) => [s.file, s.format, s.unresolved]), [
      ["Shop.sln", "sln", 1],
      ["Shop.slnx", "slnx", 1],
    ]);
    for (const solution of result.solutions) assert.deepEqual(solution.projects, expected);
    assert.equal(result.unresolved, 2);
  });
});
