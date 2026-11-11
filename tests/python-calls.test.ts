import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { BuildCodeGraphResult } from "../src/core/scan/result.js";
import { GraphStore } from "../src/adapters/store/store.js";

let result: BuildCodeGraphResult;
before(async () => {
  result = await buildCodeGraph(path.resolve("fixtures/python-calls"), { continueOnError: true, concurrency: 2 });
});

const functionLabel = (id: string) => id.replace(/^file:/u, "").replace(/:function:\d+:/u, "::");

// `file::function expression` -> the functions it resolves to ("(override)" for overrides).
const targets = (): Map<string, string[]> => {
  const byCall = new Map<string, string[]>();
  for (const rel of result.relationships) {
    if (rel.type !== "CALL_RESOLVES_TO") continue;
    byCall.set(rel.from, [...byCall.get(rel.from) ?? [], functionLabel(rel.to) + (rel.properties.via ? ` (${String(rel.properties.via)})` : "")]);
  }
  const resolved = new Map<string, string[]>();
  for (const node of result.nodes) {
    if (node.label !== "Call") continue;
    const key = functionLabel(node.id).replace(/:call:\d+:\d+:/u, " ");
    resolved.set(key, byCall.get(node.id) ?? []);
  }
  return resolved;
};

describe("Python call resolution", () => {
  const orders = "src/shop/services/orders.py::place";
  const repo = "src/shop/repo.py";

  it("resolves functions through imports, aliases and modules", () => {
    const calls = targets();
    assert.deepEqual(calls.get(`${orders} slug`), ["src/shop/util.py::slugify"]);
    assert.deepEqual(calls.get(`${orders} make_repo`), ["src/shop/util.py::make_repo"]);
    // `import shop.util as helpers`, `import shop.util`, `from .. import util`
    for (const expression of ["helpers.slugify", "shop.util.slugify", "util.slugify"]) {
      assert.deepEqual(calls.get(`${orders} ${expression}`), ["src/shop/util.py::slugify"], expression);
    }
    assert.deepEqual(calls.get("src/shop/cli.py::main run"), ["src/shop/services/orders.py::run"]);
  });

  it("resolves constructors to __init__, own or inherited, and class-qualified calls", () => {
    const calls = targets();
    // `MemoryRepo` is imported through `shop/__init__.py`.
    assert.deepEqual(calls.get(`${orders} MemoryRepo`), [`${repo}::__init__`]);
    // AuditedRepo has no __init__ of its own: MemoryRepo's.
    assert.deepEqual(calls.get("src/shop/services/orders.py::__init__ AuditedRepo"), [`${repo}::__init__`]);
    assert.deepEqual(calls.get("src/shop/services/orders.py::helper OrderService.static_helper"), ["src/shop/services/orders.py::static_helper"]);
    assert.deepEqual(calls.get("src/shop/services/orders.py::create cls.static_helper"), ["src/shop/services/orders.py::static_helper"]);
  });

  it("resolves self, super and attribute receivers", () => {
    const calls = targets();
    assert.deepEqual(calls.get(`${orders} self.helper`), ["src/shop/services/orders.py::helper"]);
    assert.deepEqual(calls.get(`${repo}::save self.log`), [`${repo}::log`]);
    assert.deepEqual(calls.get(`${repo}::save super().save`), [`${repo}::save`]);
    // `self.audit = AuditedRepo()` in __init__
    assert.deepEqual(calls.get(`${orders} self.audit.log`), [`${repo}::log`]);
  });

  it("resolves typed receivers: annotations, constructors, return types, module variables", () => {
    const calls = targets();
    assert.deepEqual(calls.get(`${orders} other.save_all`), [`${repo}::save_all`], "Repository | None parameter");
    assert.equal(calls.get(`${orders} local.save`)![0], `${repo}::save`, "local = MemoryRepo()");
    assert.equal(calls.get(`${orders} made.save`)![0], `${repo}::save`, "made = make_repo() -> MemoryRepo");
    assert.equal(calls.get(`${orders} default_repo.save`)![0], `${repo}::save`, "default_repo = MemoryRepo()");
    assert.equal(calls.get(`${orders} typed_repo.save`)![0], `${repo}::save`, "typed_repo: Repository = …");
    assert.deepEqual(calls.get("src/shop/services/orders.py::run service.place"), ["src/shop/services/orders.py::place"]);
  });

  it("reaches the overrides through a base class, marked", () => {
    const calls = targets();
    // `self.repo: Repository`: the abstract method, then MemoryRepo's and AuditedRepo's.
    assert.equal(calls.get(`${orders} self.repo.save`)!.length, 3);
    assert.equal(calls.get(`${orders} self.repo.save`)!.filter((entry) => entry.endsWith("(override)")).length, 2);
    assert.equal(calls.get(`${repo}::save_all self.save`)!.filter((entry) => entry.endsWith("(override)")).length, 2);
    // MemoryRepo.save is overridden by AuditedRepo only; super() reaches the base alone.
    assert.equal(calls.get(`${orders} local.save`)!.length, 2);
    assert.equal(calls.get(`${repo}::save super().save`)!.length, 1);
  });

  it("leaves what it cannot type unresolved, never guessed", () => {
    const calls = targets();
    for (const expression of ["self.missing", "unknown", "len"]) assert.deepEqual(calls.get(`${orders} ${expression}`), [], expression);
    // An untyped fixture parameter and a builtin type's method.
    assert.deepEqual(calls.get("tests/test_orders.py::test_place service.place"), []);
    assert.deepEqual(calls.get("src/shop/util.py::slugify text.lower"), []);
  });
});

describe("Python entrypoints and tests", () => {
  it("makes EntryPoints of the __main__ block and console scripts", () => {
    const entrypoints = result.nodes.filter((node) => node.label === "EntryPoint").map((node) => `${node.properties.kind}:${node.properties.trigger}:${node.properties.handlerName}`).sort();
    assert.deepEqual(entrypoints, ["main:__name__ == \"__main__\":main", "script:shop-admin:run", "script:shop:main"]);
    const handled = result.relationships.filter((rel) => rel.type === "ENTRYPOINT_HANDLED_BY").map((rel) => functionLabel(rel.to)).sort();
    assert.deepEqual(handled, ["src/shop/cli.py::main", "src/shop/cli.py::main", "src/shop/cli.py::run"]);
    // `Admin.run` is the method, not the module function `run`.
    const admin = result.nodes.find((node) => node.label === "Function" && node.properties.name === "run" && node.properties.className === "Admin")!;
    assert.ok(result.relationships.some((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.to === admin.id));
  });

  it("classifies pytest and unittest files and functions", () => {
    const files = result.nodes.filter((node) => node.label === "File" && node.properties.isTest === true).map((node) => node.properties.relativePath).sort();
    assert.deepEqual(files, ["tests/conftest.py", "tests/test_orders.py"]);
    const kinds = result.nodes.filter((node) => node.label === "Function" && node.properties.testKind).map((node) => `${functionLabel(node.id).replace(/^tests\//u, "")}:${node.properties.testKind}`).sort();
    assert.deepEqual(kinds, [
      "conftest.py::make_helper:helper",
      "conftest.py::service:fixture",
      "test_orders.py::build:helper",
      "test_orders.py::helper:helper",
      "test_orders.py::setUp:fixture",
      "test_orders.py::test_it:test",
      "test_orders.py::test_place:test",
      "test_orders.py::test_run:test",
    ]);
    // Production code has no test kind.
    assert.equal(result.nodes.some((node) => node.label === "Function" && node.id.startsWith("file:src/") && node.properties.testKind), false);
  });
});

describe("Python graphs in the store", () => {
  let store: GraphStore;
  before(async () => {
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-python-store-")), "graph"));
    await store.reset();
  });
  after(async () => {
    await store.close();
  });

  it("writes every Python property the parser sets (schema covers them)", async () => {
    for (const fixture of ["python-calls", "python-declarations", "python-project", "python-poetry"]) {
      const graph = await buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: true, concurrency: 2 });
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const rows = await store.query("MATCH (f:File) WHERE f.language = 'python' RETURN count(f) AS files");
      assert.ok(Number(rows[0]!.files) >= 2, fixture);
    }
  });
});
