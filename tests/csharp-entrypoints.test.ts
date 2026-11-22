import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { isCSharpTestFile } from "../src/integrations/languages/csharp/descriptor.js";
import { normaliseAttribute } from "../src/integrations/frameworks/csharp/tests.js";

const scan = (fixture: string) => buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: false });

describe("C# entrypoints (fixtures/csharp-entrypoints)", () => {
  it("makes an EntryPoint of static Main with a valid signature and of top-level statements only", async () => {
    const graph = await scan("csharp-entrypoints");
    const entries = graph.nodes
      .filter((node) => node.label === "EntryPoint")
      .map((entry) => {
        const file = graph.relationships.find((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.to === entry.id)!.from.slice("file:".length);
        const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)!.to;
        const fn = graph.nodes.find((node) => node.id === handler)!;
        return `${file}:${entry.properties.line} ${entry.properties.kind} ${entry.properties.library} ${fn.properties.name}`;
      })
      .sort();
    assert.deepEqual(entries, [
      "asyncmain/Program.cs:7 main csharp Main",
      "classic/Program.cs:5 main csharp Main",
      "toplevel/Program.cs:3 main csharp <top-level>",
    ]);
    const entry = graph.nodes.find((node) => node.label === "EntryPoint")!;
    assert.deepEqual(entry.properties, { kind: "main", trigger: null, receiverName: null, library: "csharp", line: entry.properties.line, handlerName: entry.properties.handlerName });
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
});
