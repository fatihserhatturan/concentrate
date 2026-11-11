import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { BuildCodeGraphResult } from "../src/core/scan/result.js";

let result: BuildCodeGraphResult;
before(async () => {
  result = await buildCodeGraph(path.resolve("fixtures/python-declarations"), { continueOnError: true, concurrency: 2 });
});

const find = (label: string, file: string, name: string) => result.nodes.find((node) => node.label === label && node.id.startsWith(`file:${file}:`) && node.properties.name === name)!;
const edges = (type: string) => result.relationships.filter((rel) => rel.type === type).map((rel) => `${nameOf(rel.from)} -> ${nameOf(rel.to)}`).sort();
const nameOf = (id: string) => {
  const node = result.nodes.find((candidate) => candidate.id === id)!;
  return `${id.slice("file:".length).split(":")[0]}::${String(node.properties.name)}`;
};
const json = (value: unknown) => JSON.parse(String(value)) as unknown;

describe("Python classes and interfaces", () => {
  it("makes ABC and Protocol classes interfaces with their methods", () => {
    const repository = find("Interface", "pkg/base.py", "Repository");
    assert.equal(repository.properties.kind, "abc");
    assert.deepEqual(json(repository.properties.methods), ["save", "load", "describe"]);
    assert.deepEqual(json(repository.properties.methodSignatures), {
      save: { parameters: ["str"], returnType: "None" },
      load: { parameters: ["str"], returnType: "str" },
      describe: { parameters: [], returnType: "str" },
    });
    assert.equal(find("Interface", "pkg/base.py", "Greeter").properties.kind, "protocol");
    // The abstract flag is on the method; its body belongs to the file like a trait's default method.
    assert.equal(find("Function", "pkg/base.py", "save").properties.isAbstract, true);
    assert.equal(find("Function", "pkg/base.py", "describe").properties.isAbstract, false);
    assert.equal(find("Function", "pkg/base.py", "describe").properties.className, "Repository");
  });

  it("links bases as EXTENDS, interfaces as IMPLEMENTS, through aliases and re-exports", () => {
    assert.deepEqual(edges("EXTENDS"), [
      "pkg/impl.py::Mixed -> pkg/base.py::Plain",
      "pkg/impl.py::Mixed -> pkg/impl.py::Loud",
      "pkg/impl.py::UserRepo -> pkg/impl.py::SqlRepo",
    ]);
    assert.deepEqual(edges("IMPLEMENTS"), [
      // `base.Repository` (module alias), `Repository` (re-exported by pkg/__init__.py)
      "pkg/impl.py::Cache -> pkg/base.py::Repository",
      // Structural: `Loud.greet` matches `Greeter`, imported by the file; `Quiet` does not.
      "pkg/impl.py::Loud -> pkg/base.py::Greeter",
      "pkg/impl.py::SqlRepo -> pkg/base.py::Repository",
    ]);
  });
});

describe("Python decorators and signatures", () => {
  it("makes Decorator nodes with names and arguments", () => {
    const decorators = result.nodes.filter((node) => node.label === "Decorator" && node.id.startsWith("file:pkg/service.py:")).map((node) => `${node.properties.name} ${node.properties.args}`);
    assert.deepEqual(decorators.sort(), [
      "app.get [\"\\\"/x\\\"\"]",
      "app.route [\"\\\"/health\\\"\",\"methods=[\\\"GET\\\"]\"]",
      "classmethod []",
      "functools.lru_cache [\"maxsize=8\"]",
      "functools.wraps [\"health\"]",
      "property []",
      "staticmethod []",
    ]);
    assert.ok(result.relationships.some((rel) => rel.type === "HAS_METHOD_DECORATOR" && rel.from === find("Function", "pkg/service.py", "health").id));
    assert.ok(result.relationships.some((rel) => rel.type === "HAS_DECORATOR" && rel.from === find("Class", "pkg/models.py", "User").id));
  });

  it("keeps decorated methods in their class", () => {
    const methodKinds = Object.fromEntries(result.nodes.filter((node) => node.label === "Function" && node.properties.className === "Service").map((node) => [node.properties.name, node.properties.methodKind]));
    assert.deepEqual(methodKinds, { make: "staticmethod", build: "classmethod", label: "property", cached: "method", fetch: "method" });
    const service = find("Class", "pkg/service.py", "Service");
    assert.equal(result.relationships.filter((rel) => rel.type === "DEFINES_METHOD" && rel.from === service.id).length, 5);
  });

  it("reads parameters and return types from type hints", () => {
    const fetch = find("Function", "pkg/service.py", "fetch");
    assert.deepEqual(json(fetch.properties.parameters), [
      { name: "self", type: null },
      { name: "url", type: "str" },
      { name: "retries", type: null, default: true },
      { name: "timeout", type: "float", default: true },
    ]);
    assert.equal(fetch.properties.returnType, "bytes");
    assert.equal(fetch.properties.isAsync, true);
    assert.deepEqual(json(find("Function", "pkg/service.py", "make").properties.parameters), [
      { name: "name", type: "str" },
      { name: "*args", type: null },
      { name: "size", type: "int", default: true },
      { name: "**options", type: null },
    ]);
    assert.equal(find("Function", "pkg/service.py", "make").properties.returnType, "\"Service\"");
    assert.equal(find("Function", "pkg/service.py", "build").properties.returnType, null);
  });
});

describe("Python variables and fields", () => {
  it("makes module-level variables and constants", () => {
    const variables = result.nodes.filter((node) => node.label === "Variable" && node.id.startsWith("file:pkg/models.py:"));
    assert.deepEqual(variables.map((node) => `${node.properties.name}:${node.properties.kind}:${node.properties.isExported}`), [
      "VERSION:const:true",
      "DEFAULT_LIMIT:const:true",
      "registry:variable:true",
      "_private:variable:false",
      "Pair:variable:true",
    ]);
    assert.equal(find("Variable", "pkg/models.py", "VERSION").properties.stringValue, "1.0");
    assert.equal(find("Variable", "pkg/models.py", "DEFAULT_LIMIT").properties.typeName, "int");
  });

  it("reads the fields of dataclass, NamedTuple, TypedDict, attrs and pydantic classes", () => {
    const fields = (name: string) => json(find("Class", "pkg/models.py", name).properties.fields);
    const kind = (name: string) => find("Class", "pkg/models.py", name).properties.kind;
    assert.equal(kind("User"), "dataclass");
    // `ClassVar` is not a field.
    assert.deepEqual(fields("User"), [{ name: "name", type: "str" }, { name: "age", type: "int", default: true }, { name: "tags", type: "list", default: true }]);
    assert.equal(kind("Point"), "namedtuple");
    assert.deepEqual(fields("Point"), [{ name: "x", type: "float" }, { name: "y", type: "float", default: true }]);
    assert.equal(kind("Movie"), "typeddict");
    assert.deepEqual(fields("Movie"), [{ name: "title", type: "str" }, { name: "year", type: "int" }]);
    assert.equal(kind("Legacy"), "attrs");
    assert.deepEqual(fields("Legacy"), [{ name: "name", type: null, default: true }, { name: "size", type: "int", default: true }]);
    assert.equal(kind("Item"), "pydantic");
    assert.deepEqual(fields("Item"), [{ name: "sku", type: "str" }, { name: "price", type: "float", default: true }]);
    assert.equal(kind("Color"), "enum");
    assert.equal(find("Class", "pkg/models.py", "Color").properties.fields, undefined);
  });
});
