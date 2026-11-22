import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { csharpMethods } from "./shared.js";

// xUnit, NUnit and MSTest, by attribute. The written name is normalised (`Fact`, `FactAttribute`, `Xunit.Fact`,
// `global::Xunit.FactAttribute`). A simple name counts only when the file (or a `global using` anywhere in the scan)
// imports the framework namespace, or the attribute is written fully qualified.
const TEST_ATTRIBUTES = new Set(["Fact", "Theory", "Test", "TestCase", "TestCaseSource", "TestMethod", "DataTestMethod"]);
const FIXTURE_ATTRIBUTES = new Set([
  "SetUp", "TearDown", "OneTimeSetUp", "OneTimeTearDown",
  "TestInitialize", "TestCleanup", "ClassInitialize", "ClassCleanup", "AssemblyInitialize", "AssemblyCleanup",
]);
const TEST_CLASS_ATTRIBUTES = new Set(["TestFixture", "TestClass"]);
const FRAMEWORK = /^(?:global::)?(?:Xunit|NUnit(?:\.Framework)?|Microsoft\.VisualStudio\.TestTools\.UnitTesting)(?:\.|$)/u;

// `Xunit.FactAttribute` -> `Fact`.
export function normaliseAttribute(written: string): string {
  const simple = written.slice(written.lastIndexOf(".") + 1);
  return simple.length > "Attribute".length && simple.endsWith("Attribute") ? simple.slice(0, -"Attribute".length) : simple;
}

// `test` and `fixture` mark Function.testKind, like Java. A file with a test method (or a `[TestFixture]` /
// `[TestClass]` type) that no name rule or directory called a test becomes a test file (`File.isTest`, sourceType `test`).
export const csharpTestsContributor: ISemanticContributor = {
  id: "csharp.tests",
  contribute(graph, _rootPath, report) {
    const frameworkFiles = new Set<string>();
    let frameworkEverywhere = false;
    for (const rel of graph.relationshipsOfType("IMPORTS")) {
      const imp = graph.node(rel.to)?.properties;
      const source = imp?.source;
      if (typeof source !== "string" || !FRAMEWORK.test(source) || imp?.importKind === "static") continue;
      if (imp?.isGlobal === true) frameworkEverywhere = true;
      frameworkFiles.add(rel.from);
    }
    const attributesOf = (type: "HAS_METHOD_DECORATOR" | "HAS_DECORATOR") => {
      const byOwner = new Map<string, string[]>();
      for (const rel of graph.relationshipsOfType(type)) {
        const name = graph.node(rel.to)?.properties.name;
        if (typeof name === "string") byOwner.set(rel.from, [...byOwner.get(rel.from) ?? [], name]);
      }
      return byOwner;
    };
    const methodAttributes = attributesOf("HAS_METHOD_DECORATOR");
    const classAttributes = attributesOf("HAS_DECORATOR");
    const counts = (written: string, fileId: string) => FRAMEWORK.test(written) || frameworkEverywhere || frameworkFiles.has(fileId);

    const testFiles = new Set<string>();
    for (const { node, fileId } of csharpMethods(graph)) {
      let testKind: string | null = null;
      for (const written of methodAttributes.get(node.id) ?? []) {
        if (!counts(written, fileId)) continue;
        const name = normaliseAttribute(written.replace(/^global::/u, ""));
        if (TEST_ATTRIBUTES.has(name)) testKind = "test";
        else if (FIXTURE_ATTRIBUTES.has(name) && testKind === null) testKind = "fixture";
      }
      if (!testKind) continue;
      node.properties.testKind = testKind;
      if (testKind === "test") testFiles.add(fileId);
    }
    for (const rel of graph.relationshipsOfType("DEFINES_CLASS")) {
      const fileId = rel.from;
      if (graph.node(fileId)?.properties.language !== "csharp") continue;
      if ((classAttributes.get(rel.to) ?? []).some((written) => counts(written, fileId) && TEST_CLASS_ATTRIBUTES.has(normaliseAttribute(written)))) testFiles.add(fileId);
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
