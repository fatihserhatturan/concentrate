import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { javaMethods } from "./shared.js";

// JUnit 4/5 and TestNG, by annotation. A simple name counts only when the file imports the
// framework (single or wildcard) or the annotation is written fully qualified.
const TEST_ANNOTATIONS = new Set(["Test", "ParameterizedTest", "RepeatedTest", "TestFactory", "TestTemplate"]);
const FIXTURE_ANNOTATIONS = new Set(["Before", "After", "BeforeClass", "AfterClass", "BeforeEach", "AfterEach", "BeforeAll", "AfterAll", "BeforeMethod", "AfterMethod", "BeforeTest", "AfterTest", "BeforeSuite", "AfterSuite", "BeforeGroups", "AfterGroups"]);
const FRAMEWORK = /^org\.(?:junit|testng)(?:\.|$)/u;

// `test` and `fixture` mark Function.testKind, like Python and Rust. A file with a test method
// that no name rule or directory called a test becomes a test file (`File.isTest`, sourceType `test`).
export const javaTestsContributor: ISemanticContributor = {
  id: "java.tests",
  contribute(graph, _rootPath, report) {
    const frameworkFiles = new Set<string>();
    for (const rel of graph.relationshipsOfType("IMPORTS")) {
      const source = graph.node(rel.to)?.properties.source;
      if (typeof source === "string" && FRAMEWORK.test(source)) frameworkFiles.add(rel.from);
    }
    const decorators = new Map<string, string[]>();
    for (const rel of graph.relationshipsOfType("HAS_METHOD_DECORATOR")) {
      const name = graph.node(rel.to)?.properties.name;
      if (typeof name === "string") decorators.set(rel.from, [...decorators.get(rel.from) ?? [], name]);
    }

    const testFiles = new Set<string>();
    for (const { node, fileId } of javaMethods(graph)) {
      let testKind: string | null = null;
      for (const written of decorators.get(node.id) ?? []) {
        const qualified = FRAMEWORK.test(written);
        const simple = written.slice(written.lastIndexOf(".") + 1);
        if (!qualified && !frameworkFiles.has(fileId)) continue;
        if (TEST_ANNOTATIONS.has(simple)) testKind = "test";
        else if (FIXTURE_ANNOTATIONS.has(simple) && testKind === null) testKind = "fixture";
      }
      if (!testKind) continue;
      node.properties.testKind = testKind;
      if (testKind === "test") testFiles.add(fileId);
    }

    for (const fileId of testFiles) {
      const file = graph.node(fileId);
      if (!file || file.properties.isTest === true) continue;
      file.properties.isTest = true;
      const before = file.properties.sourceType;
      if (before === "production" || before === "support") {
        file.properties.sourceType = "test";
        report.fileClassifications[before] -= 1;
        report.fileClassifications.test += 1;
      }
    }
  },
};
