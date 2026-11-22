import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { isCSharpTestFile } from "../src/integrations/languages/csharp/descriptor.js";
import { normaliseAttribute } from "../src/integrations/frameworks/csharp/tests.js";

const scan = (fixture: string) => buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: false });

const entries = (graph: Awaited<ReturnType<typeof scan>>) => graph.nodes
  .filter((node) => node.label === "EntryPoint")
  .map((entry) => {
    const file = graph.relationships.find((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.to === entry.id)!.from.slice("file:".length);
    const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)!.to;
    const fn = graph.nodes.find((node) => node.id === handler)!;
    return `${file}:${entry.properties.line} ${entry.properties.kind} ${entry.properties.library} ${fn.properties.name}`;
  })
  .sort();

async function project(files: Record<string, string>): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-ep-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

describe("C# entrypoints (fixtures/csharp-entrypoints)", () => {
  it("makes an EntryPoint of static Main with a valid signature and of top-level statements only, one project at a time", async () => {
    assert.deepEqual(entries(await scan("csharp-entrypoints/asyncmain")), ["Program.cs:7 main csharp Main"]);
    assert.deepEqual(entries(await scan("csharp-entrypoints/classic")), ["Program.cs:5 main csharp Main"]);
    assert.deepEqual(entries(await scan("csharp-entrypoints/toplevel")), ["Program.cs:3 main csharp <top-level>"]);
    const graph = await scan("csharp-entrypoints/toplevel");
    const entry = graph.nodes.find((node) => node.label === "EntryPoint")!;
    assert.deepEqual(entry.properties, { kind: "main", trigger: null, receiverName: null, library: "csharp", line: entry.properties.line, handlerName: entry.properties.handlerName });
  });

  it("keeps both static Main and top-level statements as entrypoints in one scan (CS7022 waits for projects)", async () => {
    assert.deepEqual(entries(await scan("csharp-entrypoints")), [
      "asyncmain/Program.cs:7 main csharp Main",
      "classic/Program.cs:5 main csharp Main",
      "toplevel/Program.cs:3 main csharp <top-level>",
    ]);
  });
});

describe("C# test classification (fixtures/csharp-tests)", () => {
  it("classifies xUnit, NUnit and MSTest files and marks their methods", async () => {
    const graph = await scan("csharp-tests");
    const files = graph.nodes.filter((node) => node.label === "File" && node.properties.language === "csharp")
      .map((node) => `${node.properties.relativePath}:${node.properties.isTest}`).sort();
    assert.deepEqual(files, [
      "src/Calculator.cs:false",
      "tests/MsTests.cs:true",
      "tests/NUnitTests.cs:true",
      "tests/TestHelpers.cs:true",
      "tests/XunitTests.cs:true",
    ]);
    const kinds = graph.nodes.filter((node) => node.label === "Function" && node.properties.testKind)
      .map((node) => `${node.properties.qualifiedName}:${node.properties.testKind}`).sort();
    assert.deepEqual(kinds, [
      "Acme.Tests.MsTests.Adds:test",
      "Acme.Tests.MsTests.AddsRow:test",
      "Acme.Tests.MsTests.Init:fixture",
      "Acme.Tests.NUnitTests.Adds:test",
      "Acme.Tests.NUnitTests.AddsMany:test",
      "Acme.Tests.NUnitTests.Setup:fixture",
      "Acme.Tests.XunitTests.Adds:test",
      "Acme.Tests.XunitTests.AddsMany:test",
    ]);
    const helpers = graph.nodes.filter((node) => node.label === "Function" && String(node.id).startsWith("file:tests/TestHelpers.cs"));
    assert.ok(helpers.length > 0);
    assert.ok(helpers.every((node) => !node.properties.testKind));
  });

  it("normalises attribute spellings and name conventions", () => {
    for (const written of ["Fact", "FactAttribute", "Xunit.Fact", "Xunit.FactAttribute"]) assert.equal(normaliseAttribute(written), "Fact");
    assert.equal(normaliseAttribute("Attribute"), "Attribute");
    assert.ok(isCSharpTestFile("CalculatorTests.cs"));
    assert.ok(isCSharpTestFile("CalculatorTest.cs"));
    assert.equal(isCSharpTestFile("Latest.cs"), false);
    assert.equal(isCSharpTestFile("TestHelpers.cs"), false);
  });

  it("maps each framework to its own attributes and namespace", async () => {
    const { dir, done } = await project({
      "WrongNunit.cs": "using Xunit;\nclass WrongNunit { [Test] public void T() { } [SetUp] public void S() { } }\n",
      "WrongXunit.cs": "using NUnit.Framework;\nclass WrongXunit { [Fact] public void T() { } [TestMethod] public void U() { } }\n",
      "NoImport.cs": "class NoImport { [Fact] public void T() { } }\n",
      "RightXunit.cs": "using Xunit;\nclass RightXunit { [Theory] public void T() { } }\n",
      "Scoped.cs": "namespace N { using NUnit.Framework;\n class Scoped { [TestCase(1)] public void T() { } } }\n",
      "Alias.cs": "using X = Xunit.FactAttribute;\nclass Alias { [X] public void T() { } }\n",
      "Qualified.cs": "class Qualified { [Microsoft.VisualStudio.TestTools.UnitTesting.TestMethod] public void T() { } }\n",
      "Mstest.cs": "using Microsoft.VisualStudio.TestTools.UnitTesting;\n[TestClass] class Mstest { }\n",
    });
    try {
      const graph = await buildCodeGraph(dir, { continueOnError: false });
      const files = graph.nodes.filter((node) => node.label === "File" && node.properties.language === "csharp")
        .map((node) => `${node.properties.relativePath}:${node.properties.isTest}`).sort();
      assert.deepEqual(files, [
        "Alias.cs:true", "Mstest.cs:true", "NoImport.cs:false", "Qualified.cs:true", "RightXunit.cs:true", "Scoped.cs:true", "WrongNunit.cs:false", "WrongXunit.cs:false",
      ]);
    } finally {
      await done();
    }
  });

  it("takes a global using of the framework for every file", async () => {
    const { dir, done } = await project({
      "Usings.cs": "global using NUnit.Framework;\n",
      "Anywhere.cs": "class Anywhere { [Test] public void T() { } }\n",
      "Other.cs": "class Other { [Fact] public void T() { } }\n",
    });
    try {
      const graph = await buildCodeGraph(dir, { continueOnError: false });
      const tests = graph.nodes.filter((node) => node.label === "File" && node.properties.isTest === true).map((node) => node.properties.relativePath);
      assert.deepEqual(tests, ["Anywhere.cs"]);
    } finally {
      await done();
    }
  });
});
