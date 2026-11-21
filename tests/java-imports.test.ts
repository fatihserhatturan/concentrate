import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { buildJavaPackageIndex } from "../src/integrations/languages/java/packages.js";
import { conventionalJavaSourceRoot, inferredJavaSourceRoot, JavaSourceRoots } from "../src/integrations/languages/java/source-roots.js";
import { GraphBuilder } from "../src/core/graph/builder.js";

const scan = async (fixture: string) => {
  const result = await buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: true, concurrency: 2 });
  const strip = (id: string) => id.replace(/^file:/u, "");
  const importsOf = (file: string) => result.nodes.filter((node) => node.label === "Import" && node.id.startsWith(`file:${file}:import:`));
  const targets = (importId: string) =>
    result.relationships.filter((r) => r.type === "RESOLVES_TO" && r.from === importId).map((r) => strip(r.to)).sort();
  const bySource = (file: string, source: string) => {
    const node = importsOf(file).find((candidate) => candidate.properties.source === source);
    assert.ok(node, `import ${source} in ${file}`);
    return node;
  };
  return { result, importsOf, targets, bySource };
};

describe("Java source roots", () => {
  it("takes conventional roots", () => {
    assert.equal(conventionalJavaSourceRoot("src/main/java/com/acme/A.java"), "src/main/java");
    assert.equal(conventionalJavaSourceRoot("mod/src/test/java/com/A.java"), "mod/src/test/java");
    assert.equal(conventionalJavaSourceRoot("src/integrationTest/java/A.java"), "src/integrationTest/java");
    assert.equal(conventionalJavaSourceRoot("core/com/acme/A.java"), null);
  });

  it("infers roots from the package path", () => {
    assert.equal(inferredJavaSourceRoot("x/y/com/acme/Foo.java", "com.acme"), "x/y");
    assert.equal(inferredJavaSourceRoot("com/acme/Foo.java", "com.acme"), ".");
    assert.equal(inferredJavaSourceRoot("x/other/Foo.java", "com.acme"), null);
    assert.equal(inferredJavaSourceRoot("x/Foo.java", undefined), "x");
  });

  it("lets a build system add roots that win over inference", () => {
    const roots = new JavaSourceRoots();
    roots.addRoot("gen/");
    assert.equal(roots.rootOf("gen/com/acme/A.java", "com.acme"), "gen");
    assert.equal(roots.rootOf("core/com/acme/B.java", "com.acme"), "core");
    assert.deepEqual(roots.all(), ["core", "gen"]);
  });
});

describe("Java imports", () => {
  it("resolves type, wildcard and static imports in java-packages", async () => {
    const { targets, bySource } = await scan("java-packages");
    const main = "app/com/acme/app/Main.java";
    const imp = (source: string) => targets(bySource(main, source).id);
    assert.deepEqual(imp("com.acme.model.User"), ["core/com/acme/model/User.java"]);
    // A wildcard import names a package, not a file: it resolves to none.
    assert.deepEqual(imp("com.acme.model"), []);
    assert.deepEqual(imp("com.acme.util.Strings"), ["core/com/acme/util/Strings.java"]);
    assert.deepEqual(imp("com.acme.util.Strings.upper"), ["core/com/acme/util/Strings.java"]);
    assert.deepEqual(imp("com.acme.util.Ids"), ["core/com/acme/util/Ids.java"]);
    assert.equal(bySource(main, "com.acme.model").properties.isWildcard, true);
    assert.equal(bySource(main, "com.acme.util.Ids").properties.isStatic, true);
  });

  it("leaves the JDK, Jakarta and unknown packages external", async () => {
    const { targets, bySource, result } = await scan("java-packages");
    for (const source of ["java.util.List", "jakarta.inject.Inject", "org.apache.commons.lang3.StringUtils"]) {
      assert.deepEqual(targets(bySource("app/com/acme/app/Main.java", source).id), [], source);
    }
    assert.deepEqual(targets(bySource("core/com/acme/model/User.java", "javax.annotation.Nullable").id), []);
    // External imports are not counted as unresolved project imports.
    assert.equal(result.nodes.some((n) => n.label === "Import" && n.properties.source === "java.util.List"), true);
  });

  it("infers the roots of java-packages and conventional roots of java-unused", async () => {
    for (const [fixture, expected] of [
      ["java-packages", ["app", "core"]],
      ["java-unused", ["src/main/java"]],
    ] as const) {
      const { result } = await scan(fixture);
      const graph = new GraphBuilder();
      graph.addNodes(result.nodes);
      graph.addRelationships(result.relationships);
      const index = buildJavaPackageIndex(graph);
      assert.deepEqual(index.sourceRoots.all(), expected, fixture);
    }
  });

  it("exposes package and type lookups", async () => {
    const { result } = await scan("java-packages");
    const graph = new GraphBuilder();
    graph.addNodes(result.nodes);
    graph.addRelationships(result.relationships);
    const index = buildJavaPackageIndex(graph);
    assert.deepEqual(index.packageFiles("com.acme.app"), ["file:app/com/acme/app/Helper.java", "file:app/com/acme/app/Main.java"]);
    assert.equal(index.typeFile("com.acme.model.User"), "file:core/com/acme/model/User.java");
    // Same-package types need no import.
    assert.equal(index.typeInPackage("com.acme.app", "Helper"), "com.acme.app.Helper");
    assert.equal(index.typeInPackage("com.acme.model", "Address"), "com.acme.model.Address");
    assert.equal(index.typeInPackage("com.acme.app", "Address"), undefined);
    assert.equal(index.packageOfFile("file:app/com/acme/app/Main.java"), "com.acme.app");
    assert.equal(index.longestTypePrefix("com.acme.util.Strings.upper"), "com.acme.util.Strings");
    assert.deepEqual(index.resolveImport({ source: "com.acme.model.Missing", isWildcard: false, isStatic: false }), { fileIds: [], expected: true });
    assert.deepEqual(index.resolveImport({ source: "org.x.Y", isWildcard: false, isStatic: false }), { fileIds: [], expected: false });
  });

  it("resolves static imports of java-calls to the class file", async () => {
    const { result, targets } = await scan("java-calls");
    const staticImports = result.nodes.filter((n) => n.label === "Import" && n.properties.isStatic === true);
    assert.ok(staticImports.length > 0);
    for (const node of staticImports) assert.equal(targets(node.id).length, 1, String(node.properties.source));
  });
});
