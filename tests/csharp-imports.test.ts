import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { buildCSharpNamespaceIndex, usingsInScope } from "../src/integrations/languages/csharp/namespaces.js";
import { setCSharpNamespaceIndex } from "../src/integrations/languages/csharp/project.js";
import { GraphBuilder } from "../src/core/graph/builder.js";

const strip = (id: string) => id.replace(/^file:/u, "");

describe("C# namespace index (unit)", () => {
  const build = () => {
    const graph = new GraphBuilder();
    const file = (id: string, namespaces: string[]) =>
      graph.addNode({ id, label: "File", properties: { language: "csharp", relativePath: id, csharpNamespaces: JSON.stringify(namespaces) } });
    file("file:a.cs", ["A.B.C"]);
    file("file:b.cs", ["A.B.C", "X"]);
    graph.addNode({ id: "csharp:partial:A.B.C.T", label: "Class", properties: { qualifiedName: "A.B.C.T", namespace: "A.B.C", nesting: "top-level" } });
    graph.addNode({ id: "n1", label: "Class", properties: { qualifiedName: "A.B.C.T.In", namespace: "A.B.C", nesting: "nested" } });
    for (const from of ["file:a.cs", "file:b.cs"]) graph.addRelationship({ from, to: "csharp:partial:A.B.C.T", type: "DEFINES_CLASS", properties: {} });
    return graph;
  };

  it("indexes ancestors without files, and top-level types once", () => {
    const index = buildCSharpNamespaceIndex(build());
    assert.deepEqual(index.namespaces, ["A", "A.B", "A.B.C", "X"]);
    assert.ok(index.hasNamespace("A.B"));
    assert.deepEqual(index.filesOf("A.B"), []);
    assert.deepEqual(index.filesOf("A.B.C"), ["file:a.cs", "file:b.cs"]);
    assert.deepEqual(index.typeIdsIn("A.B.C"), ["csharp:partial:A.B.C.T"]);
    assert.deepEqual(index.typeIdsIn("Nope"), []);
  });

  it("reports the enclosing chain when there are no usings", () => {
    const graph = build();
    setCSharpNamespaceIndex(graph, buildCSharpNamespaceIndex(graph));
    assert.deepEqual(usingsInScope(graph, "file:a.cs", "A.B.C").namespaces, ["A.B.C", "A.B", "A", ""]);
  });
});

describe("C# using resolution (fixtures/csharp-namespaces)", () => {
  it("resolves usings to files and counts only own-root misses as unresolved", async () => {
    const result = await buildCodeGraph(path.resolve("fixtures", "csharp-namespaces"), { continueOnError: true, concurrency: 2 });
    const imp = (file: string, source: string) => {
      const node = result.nodes.find((n) => n.label === "Import" && n.id.startsWith(`file:${file}:import:`) && n.properties.source === source);
      assert.ok(node, `${source} in ${file}`);
      return node;
    };
    const targets = (id: string) => result.relationships.filter((r) => r.type === "RESOLVES_TO" && r.from === id).map((r) => strip(r.to)).sort();

    assert.deepEqual(targets(imp("app/Program.cs", "Acme.Models").id), ["src/Models/Deep/Currency.cs", "src/Models/Money.cs"]);
    assert.deepEqual(targets(imp("app/Program.cs", "Acme.Core").id), ["src/Core/Greeter.cs", "src/Core/Helpers.cs"]);
    assert.deepEqual(targets(imp("app/Program.cs", "Acme.Core.Helpers").id), ["src/Core/Helpers.cs"]);
    assert.deepEqual(targets(imp("GlobalUsings.cs", "Acme.Shared").id), ["src/Models/Deep/Constants.cs"]);
    assert.deepEqual(targets(imp("src/Core/Greeter.cs", "Acme.Shared.Constants").id), ["src/Models/Deep/Constants.cs"]);
    assert.deepEqual(targets(imp("src/Core/Greeter.cs", "Acme.Models.Money").id), ["src/Models/Money.cs"]);
    // Only `Acme.Missing.Library` counts; System/Microsoft are external.
    assert.equal(result.report.unresolvedRelativeImports, 1);
    for (const [file, source] of [
      ["src/Core/Greeter.cs", "System.Text"],
      ["src/Core/Greeter.cs", "Microsoft.Extensions.Logging"],
      ["src/Core/Greeter.cs", "Acme.Missing.Library"],
      ["GlobalUsings.cs", "System"],
    ] as const) {
      assert.deepEqual(targets(imp(file, source).id), [], `${source} unresolved`);
    }
  });
});
