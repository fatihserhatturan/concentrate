import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { csharpMethods } from "./shared.js";

// xUnit, NUnit and MSTest, each with its own attributes. The written name is normalised (`Fact`, `FactAttribute`,
// `Xunit.Fact`, `global::Xunit.FactAttribute`) and a using alias is followed (`using F = Xunit.FactAttribute; [F]`). A
// simple name counts only when THAT framework's namespace is imported by the file (a `using` at any scope) or by a
// `global using` anywhere in the scan, so `using Xunit; [Test]` is no test; a name written fully qualified always counts.
type Framework = { namespace: string; tests: ReadonlySet<string>; fixtures: ReadonlySet<string>; classes: ReadonlySet<string> };
const FRAMEWORKS: readonly Framework[] = [
  { namespace: "Xunit", tests: new Set(["Fact", "Theory"]), fixtures: new Set(), classes: new Set() },
  {
    namespace: "NUnit.Framework",
    tests: new Set(["Test", "TestCase", "TestCaseSource", "Theory"]),
    fixtures: new Set(["SetUp", "TearDown", "OneTimeSetUp", "OneTimeTearDown"]),
    classes: new Set(["TestFixture"]),
  },
  {
    namespace: "Microsoft.VisualStudio.TestTools.UnitTesting",
    tests: new Set(["TestMethod", "DataTestMethod"]),
    fixtures: new Set(["TestInitialize", "TestCleanup", "ClassInitialize", "ClassCleanup", "AssemblyInitialize", "AssemblyCleanup"]),
    classes: new Set(["TestClass"]),
  },
];

// `Xunit.FactAttribute` -> `Fact`.
export function normaliseAttribute(written: string): string {
  const simple = written.slice(written.lastIndexOf(".") + 1);
  return simple.length > "Attribute".length && simple.endsWith("Attribute") ? simple.slice(0, -"Attribute".length) : simple;
}

const withoutGlobal = (name: string): string => name.replace(/^global::/u, "");

// `test` and `fixture` mark Function.testKind, like Java. A file with a test method (or a `[TestFixture]` /
// `[TestClass]` type) that no name rule or directory called a test becomes a test file (`File.isTest`, sourceType `test`).
export const csharpTestsContributor: ISemanticContributor = {
  id: "csharp.tests",
  contribute(graph, _rootPath, report) {
    const importedBy = new Map<Framework, Set<string>>(FRAMEWORKS.map((framework) => [framework, new Set<string>()]));
    const everywhere = new Set<Framework>();
    const fileAliases = new Map<string, Map<string, string>>();
    const globalAliases = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("IMPORTS")) {
      const imp = graph.node(rel.to)?.properties;
      const source = imp?.source;
      if (typeof source !== "string") continue;
      if (imp?.importKind === "alias" && typeof imp.alias === "string") {
        if (imp.isGlobal === true) globalAliases.set(imp.alias, withoutGlobal(source));
        else fileAliases.set(rel.from, (fileAliases.get(rel.from) ?? new Map()).set(imp.alias, withoutGlobal(source)));
        continue;
      }
      if (imp?.importKind === "static") continue;
      const framework = FRAMEWORKS.find((candidate) => candidate.namespace === withoutGlobal(source));
      if (!framework) continue;
      importedBy.get(framework)!.add(rel.from);
      if (imp?.isGlobal === true) everywhere.add(framework);
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
    // The framework and normalised attribute name a written attribute stands for in a file, or null.
    const resolve = (written: string, fileId: string): { framework: Framework; name: string } | null => {
      let name = withoutGlobal(written);
      const first = name.split(".")[0]!;
      const alias = fileAliases.get(fileId)?.get(first) ?? globalAliases.get(first);
      if (alias) name = `${alias}${name.slice(first.length)}`;
      const qualified = FRAMEWORKS.find((framework) => name.startsWith(`${framework.namespace}.`));
      if (qualified) return { framework: qualified, name: normaliseAttribute(name) };
      if (name.includes(".")) return null;
      const simple = normaliseAttribute(name);
      const framework = FRAMEWORKS.find((candidate) => (everywhere.has(candidate) || importedBy.get(candidate)!.has(fileId))
        && (candidate.tests.has(simple) || candidate.fixtures.has(simple) || candidate.classes.has(simple)));
      return framework ? { framework, name: simple } : null;
    };

    const testFiles = new Set<string>();
    for (const { node, fileId } of csharpMethods(graph)) {
      let testKind: string | null = null;
      for (const written of methodAttributes.get(node.id) ?? []) {
        const found = resolve(written, fileId);
        if (!found) continue;
        if (found.framework.tests.has(found.name)) testKind = "test";
        else if (found.framework.fixtures.has(found.name) && testKind === null) testKind = "fixture";
      }
      if (!testKind) continue;
      node.properties.testKind = testKind;
      if (testKind === "test") testFiles.add(fileId);
    }
    for (const rel of graph.relationshipsOfType("DEFINES_CLASS")) {
      const fileId = rel.from;
      if (graph.node(fileId)?.properties.language !== "csharp") continue;
      const isTestClass = (classAttributes.get(rel.to) ?? []).some((written) => {
        const found = resolve(written, fileId);
        return found !== null && found.framework.classes.has(found.name);
      });
      if (isTestClass) testFiles.add(fileId);
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
