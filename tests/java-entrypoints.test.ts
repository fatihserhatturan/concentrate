import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { isJavaTestFile } from "../src/integrations/languages/java/descriptor.js";

const scan = () => buildCodeGraph(path.resolve("fixtures/java-entrypoints"), { continueOnError: false });

describe("Java entrypoints (fixtures/java-entrypoints)", () => {
  it("makes an EntryPoint of public static void main(String[]) and main(String...) only", async () => {
    const graph = await scan();
    const entries = graph.nodes
      .filter((node) => node.label === "EntryPoint")
      .map((entry) => {
        const file = graph.relationships.find((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.to === entry.id)!.from.slice("file:".length);
        const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)!.to;
        const fn = graph.nodes.find((node) => node.id === handler)!;
        return `${file}:${entry.properties.line} ${entry.properties.kind} ${entry.properties.library} ${fn.properties.qualifiedName}(${fn.properties.parameterCount})`;
      })
      .sort();
    assert.deepEqual(entries, [
      "src/main/java/com/acme/App.java:4 main java com.acme.App.main(1)",
      "src/main/java/com/acme/Varargs.java:4 main java com.acme.Varargs.main(1)",
    ]);
    const entry = graph.nodes.find((node) => node.label === "EntryPoint")!;
    assert.deepEqual(entry.properties, { kind: "main", trigger: null, receiverName: null, library: "java", line: entry.properties.line, handlerName: "main" });
  });
});

describe("Java test classification (fixtures/java-entrypoints)", () => {
  it("classifies files by directory, name and annotation", async () => {
    const graph = await scan();
    const files = graph.nodes
      .filter((node) => node.label === "File" && node.properties.language === "java")
      .map((node) => `${node.properties.relativePath}:${node.properties.isTest}`)
      .sort();
    assert.deepEqual(files, [
      "src/main/java/com/acme/App.java:false",
      "src/main/java/com/acme/Other.java:false",
      "src/main/java/com/acme/Varargs.java:false",
      "src/test/java/com/acme/Junit4Test.java:true",
      "src/test/java/com/acme/Junit5Test.java:true",
      "src/test/java/com/acme/TestNgTest.java:true",
      // The name alone makes these tests: tools/ is no test directory, and LooksLikeTest has no annotation.
      "tools/FooTest.java:true",
      "tools/LooksLikeTest.java:true",
    ]);
  });

  it("marks JUnit 4, JUnit 5 and TestNG methods as tests and leaves helpers alone", async () => {
    const graph = await scan();
    const methods = graph.nodes
      .filter((node) => node.label === "Function" && node.properties.testKind)
      .map((node) => `${node.properties.testKind}:${node.properties.qualifiedName}`)
      .sort();
    assert.deepEqual(methods, [
      "test:com.acme.Junit4Test.adds",
      "test:com.acme.Junit4Test.subtracts",
      "test:com.acme.Junit5Test.param",
      "test:com.acme.Junit5Test.plain",
      "test:com.acme.TestNgTest.ng",
      "test:tools.FooTest.outside",
    ]);
  });

  it("marks a file with test annotations as a test file when no name or directory says so", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-tests-"));
    try {
      await mkdir(path.join(dir, "src/main/java/app"), { recursive: true });
      await writeFile(path.join(dir, "src/main/java/app/Checks.java"), "package app;\nimport org.junit.jupiter.api.*;\nclass Checks {\n  @BeforeEach void setUp() {}\n  @RepeatedTest(3) void again() {}\n  @TestFactory Object dyn() { return null; }\n  void helper() {}\n}\n");
      await writeFile(path.join(dir, "src/main/java/app/Plain.java"), "package app;\nclass Plain {\n  @Test void notJunit() {}\n}\n");
      const graph = await buildCodeGraph(dir, { continueOnError: false });
      const file = (name: string) => graph.nodes.find((node) => node.label === "File" && node.properties.relativePath === `src/main/java/app/${name}`)!.properties;
      assert.equal(file("Checks.java").isTest, true);
      assert.equal(file("Checks.java").sourceType, "test");
      assert.equal(file("Plain.java").isTest, false);
      const kinds = graph.nodes.filter((node) => node.label === "Function" && node.properties.testKind).map((node) => `${node.properties.testKind}:${node.properties.name}`).sort();
      assert.deepEqual(kinds, ["fixture:setUp", "test:again", "test:dyn"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("follows the Surefire and Failsafe file name patterns", () => {
    for (const name of ["FooTest.java", "FooTests.java", "FooTestCase.java", "TestFoo.java", "Test.java", "FooIT.java", "FooITCase.java", "LooksLikeTest.java"]) {
      assert.equal(isJavaTestFile(name), true, name);
    }
    for (const name of ["Foo.java", "Testament.java", "EDIT.java", "Latest.java", "Contest.java", "FooTest.txt", "App.java"]) {
      assert.equal(isJavaTestFile(name), false, name);
    }
  });
});
