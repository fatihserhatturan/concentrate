import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { readPythonProjects } from "../src/integrations/languages/python/project.js";

const scan = async (fixture: string) => {
  const result = await buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: true, concurrency: 2 });
  const files = new Map<string, string>();
  for (const relationship of result.relationships) {
    if (relationship.type === "RESOLVES_TO") files.set(relationship.from.replace(/^file:/u, ""), relationship.to.replace(/^file:/u, ""));
  }
  const imports = (file: string) => result.nodes.filter((node) => node.label === "Import" && node.id.startsWith(`file:${file}:import:`));
  return { result, resolved: (importId: string) => files.get(importId), imports };
};

describe("Python project metadata", () => {
  it("reads PEP 621 with setuptools `where`, scripts and dependency names", async () => {
    const [project] = await readPythonProjects(path.resolve("fixtures/python-project"), ["pyproject.toml", "src/shop/__init__.py"]);
    assert.equal(project!.name, "shop-app");
    assert.equal(project!.version, "1.2.0");
    assert.equal(project!.manager, "setuptools");
    assert.deepEqual(project!.sourceRoots, ["src", "."]);
    assert.deepEqual(project!.dependencies, ["requests", "pydantic"]);
    assert.deepEqual(project!.scripts, [{ name: "shop", target: "shop.cli:main" }]);
  });

  it("reads Poetry packages, groups and scripts", async () => {
    const [project] = await readPythonProjects(path.resolve("fixtures/python-poetry"), ["pyproject.toml"]);
    assert.equal(project!.manager, "poetry");
    assert.deepEqual(project!.sourceRoots, ["lib", "."]);
    assert.deepEqual(project!.dependencies, ["fastapi", "pytest"]);
    assert.deepEqual(project!.scripts, [{ name: "demo", target: "poetrylib.core:run" }]);
  });

  it("reads setup.cfg package_dir, entry points and requirements, over setup.py", async () => {
    const [project] = await readPythonProjects(path.resolve("fixtures/python-setuptools"), ["setup.cfg", "setup.py"]);
    assert.equal(project!.name, "cfg-demo");
    assert.deepEqual(project!.sourceRoots, ["pylib", "."]);
    assert.deepEqual(project!.dependencies, ["click", "rich"]);
    assert.deepEqual(project!.scripts, [{ name: "cfg-demo", target: "legacy.tool:main" }]);
    assert.deepEqual(project!.files, ["setup.cfg", "setup.py"]);
  });

  it("reads literals of setup.py without running it", async () => {
    const dir = path.resolve("fixtures/python-setuptools");
    const [project] = await readPythonProjects(dir, ["setup.py"]);
    assert.equal(project!.name, "cfg-demo");
    assert.deepEqual(project!.sourceRoots, ["pylib", "."]);
  });

  it("ignores a pyproject.toml that only configures tools", async () => {
    const projects = await readPythonProjects(path.resolve("fixtures/python-basic"), ["pyproject.toml"]);
    assert.deepEqual(projects, []);
  });
});

describe("Python packages in the graph", () => {
  it("adds a Package node with the manager and owns the files", async () => {
    const { result } = await scan("python-poetry");
    const packages = result.nodes.filter((node) => node.label === "Package");
    assert.equal(packages.length, 1);
    assert.equal(packages[0]!.properties.name, "poetry-demo");
    assert.equal(packages[0]!.properties.manager, "poetry");
    assert.ok(result.relationships.some((rel) => rel.type === "PACKAGE_CONTAINS_FILE" && rel.to === "file:lib/poetrylib/core.py"));
  });
});

describe("Python imports", () => {
  it("resolves the src layout, relative imports, aliases and star imports", async () => {
    const { resolved } = await scan("python-project");
    const orders = "src/shop/services/orders.py:import";
    assert.equal(resolved(`${orders}:4:shop.models`), "src/shop/models.py");
    assert.equal(resolved(`${orders}:5:shop.utils`), "src/shop/utils.py");
    // `from . import pricing` and `from .. import utils as helpers` name submodules.
    assert.equal(resolved(`${orders}:8:.`), "src/shop/services/pricing.py");
    assert.equal(resolved(`${orders}:9:..`), "src/shop/utils.py");
    assert.equal(resolved(`${orders}:10:..models`), "src/shop/models.py");
    assert.equal(resolved(`${orders}:11:shop.utils`), "src/shop/utils.py");
    // A package imported by name lands in its `__init__.py`.
    assert.equal(resolved("src/shop/cli.py:import:3:shop"), "src/shop/__init__.py");
    // pytest puts the test directory on the path; the package comes from the source root.
    assert.equal(resolved("tests/test_orders.py:import:1:shop.services.orders"), "src/shop/services/orders.py");
    assert.equal(resolved("tests/test_orders.py:import:2:shop.services"), "src/shop/services/pricing.py");
  });

  it("records bindings, aliases, wildcards and type-only imports", async () => {
    const { imports } = await scan("python-project");
    const byLine = (line: number) => imports("src/shop/services/orders.py").filter((node) => node.properties.line === line).map((node) => node.properties);
    assert.equal(byLine(4)[0]!.alias, "m");
    assert.deepEqual(JSON.parse(String(byLine(4)[0]!.bindings)), [{ imported: "shop.models", local: "m", kind: "namespace" }]);
    assert.deepEqual(byLine(10).map((p) => JSON.parse(String(p.bindings))[0]), [
      { imported: "Order", local: "Order", kind: "named" },
      { imported: "Customer", local: "Buyer", kind: "named" },
    ]);
    assert.equal(byLine(11)[0]!.isWildcard, true);
    assert.equal(byLine(14)[0]!.isTypeOnly, true);
    assert.equal(byLine(10)[0]!.isTypeOnly, undefined);
  });

  it("reads __all__, including += and tuples", async () => {
    const { result } = await scan("python-project");
    const names = (file: string) => {
      const value = result.nodes.find((node) => node.id === `file:${file}`)?.properties.allNames;
      return typeof value === "string" ? JSON.parse(value) as string[] : null;
    };
    assert.deepEqual(names("src/shop/__init__.py"), ["Order", "Customer", "place", "VERSION"]);
    assert.deepEqual(names("src/shop/utils.py"), ["slugify"]);
    assert.equal(names("src/shop/models.py"), null);
    const poetry = await scan("python-poetry");
    assert.deepEqual(JSON.parse(String(poetry.result.nodes.find((node) => node.id === "file:lib/poetrylib/__init__.py")!.properties.allNames)), ["run"]);
  });

  it("counts only project modules as unresolved, never stdlib or third-party", async () => {
    const { result, resolved } = await scan("python-poetry");
    assert.equal(resolved("app.py:import:1:poetrylib"), "lib/poetrylib/__init__.py");
    assert.equal(resolved("app.py:import:2:poetrylib.core"), "lib/poetrylib/core.py");
    assert.equal(resolved("app.py:import:3:missing_package.inner"), undefined);
    // `.sibling` is relative and absent: the one miss.
    assert.equal(result.report.unresolvedRelativeImports, 1);
  });

  it("resolves a package-dir root from setup.cfg", async () => {
    const { resolved } = await scan("python-setuptools");
    assert.equal(resolved("pylib/legacy/tool.py:import:1:legacy"), "pylib/legacy/helpers.py");
    assert.equal(resolved("pylib/legacy/tool.py:import:2:legacy.helpers"), "pylib/legacy/helpers.py");
  });
});

describe("Python syntax errors", () => {
  it("keeps the statements around the broken ones and warns", async () => {
    const { result } = await scan("python-syntax-error");
    assert.equal(result.report.status, "success");
    assert.deepEqual(result.report.warnings.map((warning) => warning.message), ["Syntax error: left out the statements at lines 4, 12, 21"]);
    const names = result.nodes.filter((node) => node.label === "Function" || node.label === "Class").map((node) => node.properties.name);
    assert.deepEqual(names, ["before", "broken", "After", "kept", "bad", "also_kept", "fine"]);
    assert.equal(result.nodes.filter((node) => node.label === "Import").length, 2);
  });
});
