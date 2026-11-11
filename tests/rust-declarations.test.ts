import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { BuildCodeGraphResult } from "../src/core/scan/result.js";

let result: BuildCodeGraphResult;
const node = (label: string, name: string) => result.nodes.find((candidate) => candidate.label === label && candidate.properties.name === name)!;
const edges = (type: string) => result.relationships.filter((relationship) => relationship.type === type);
const nameOf = (id: string) => String(result.nodes.find((candidate) => candidate.id === id)?.properties.name);

describe("Rust declarations", () => {
  before(async () => {
    result = await buildCodeGraph(path.resolve("fixtures/rust-declarations"), { continueOnError: true, concurrency: 2 });
  });

  it("records traits as interfaces and impl Trait for X as IMPLEMENTS", () => {
    const shape = node("Interface", "Shape");
    assert.deepEqual(JSON.parse(String(shape.properties.methods)), ["area", "name"]);
    assert.deepEqual(JSON.parse(String(shape.properties.embeds)), ["Display"]);
    assert.equal(node("Interface", "Scalable").properties.typeParameters, "<T>");
    const implemented = edges("IMPLEMENTS").map((edge) => `${nameOf(edge.from)}->${nameOf(edge.to)}`).sort();
    // Display is std: not a node of the scan.
    assert.deepEqual(implemented, ["Circle->Scalable", "Circle->Shape"]);
  });

  it("marks trait default and trait impl methods", () => {
    assert.equal(node("Function", "name").properties.methodKind, "trait-default");
    assert.equal(node("Function", "name").properties.className, "Shape");
    const area = node("Function", "area");
    const impl = result.nodes.find((candidate) => candidate.label === "Function" && candidate.properties.name === "area" && candidate.properties.className === "Circle")!;
    assert.equal(impl.properties.implementsTrait, "Shape");
    assert.equal(impl.properties.methodKind, "trait-impl");
    assert.ok(area);
  });

  it("records enums, type aliases, generics, const and static", () => {
    assert.deepEqual(JSON.parse(String(node("Enum", "Kind").properties.variants)), ["Round", "Square", "Other"]);
    assert.equal(node("TypeAlias", "Pair").properties.typeParameters, "<T>");
    assert.equal(node("TypeAlias", "Id").properties.aliasOf, "u64");
    assert.equal(node("Class", "Wrapper").properties.typeParameters, "<T>");
    assert.equal(node("Function", "largest").properties.typeParameters, "<T: PartialOrd + Copy>");
    assert.equal(node("Variable", "MAX_SIDES").properties.kind, "const");
    assert.equal(node("Variable", "GREETING").properties.kind, "static");
    assert.equal(node("Variable", "GREETING").properties.stringValue, "hello");
    assert.equal(node("Variable", "PRIVATE_LIMIT").properties.isExported, false);
    assert.deepEqual(JSON.parse(String(node("Class", "Meters").properties.fields)), [{ name: "0", type: "f64" }, { name: "1", type: "u8" }]);
  });

  it("records attributes as decorators, derive included", () => {
    const circle = node("Class", "Circle");
    const decorators = edges("HAS_DECORATOR").filter((edge) => edge.from === circle.id).map((edge) => result.nodes.find((candidate) => candidate.id === edge.to)!);
    assert.deepEqual(decorators.map((decorator) => decorator.properties.name), ["derive"]);
    assert.deepEqual(JSON.parse(String(decorators[0]!.properties.args)), ["Debug", "Clone", "PartialEq"]);
    const kindDecorators = edges("ENUM_HAS_DECORATOR").map((edge) => nameOf(edge.to)).sort();
    assert.deepEqual(kindDecorators, ["derive", "repr"]);
    const health = node("Decorator", "get");
    assert.deepEqual(JSON.parse(String(health.properties.args)), ["\"/health\""]);
  });

  it("records macro_rules, parameters and return types", () => {
    assert.equal(node("Function", "square").properties.kind, "macro_rules");
    assert.equal(node("Function", "double").properties.isExported, true);
    const largest = node("Function", "largest");
    assert.deepEqual(JSON.parse(String(largest.properties.parameters)), [{ name: "items", type: "&[T]" }]);
    assert.equal(largest.properties.returnType, "Option<T>");
    const scale = node("Function", "scale");
    assert.ok(scale);
    const impl = result.nodes.find((candidate) => candidate.label === "Function" && candidate.properties.name === "scale" && candidate.properties.className === "Circle")!;
    assert.deepEqual(JSON.parse(String(impl.properties.parameters)), [{ name: "self", type: "&mut Self" }, { name: "by", type: "f64" }]);
    // The macro call resolves to the macro.
    const call = result.relationships.find((relationship) => relationship.type === "CALL_RESOLVES_TO" && relationship.from.includes("area_of_square") && relationship.to.includes("square"));
    assert.ok(call);
  });

  it("records fn main, #[tokio::main] and #[actix_web::main] as entrypoints", () => {
    const entrypoints = result.nodes.filter((candidate) => candidate.label === "EntryPoint")
      .map((candidate) => `${candidate.properties.library}:${candidate.properties.handlerName}`).sort();
    assert.deepEqual(entrypoints, ["actix-web:serve", "rust:main", "tokio:main"]);
  });

  it("classifies #[test], #[tokio::test], cfg(test) modules and tests.rs as tests", () => {
    const kind = (name: string, line?: number) => result.nodes.find((candidate) => candidate.label === "Function" && candidate.properties.name === name && (line === undefined || candidate.properties.line === line))!.properties.testKind;
    assert.equal(kind("squares"), "test");
    assert.equal(kind("async_case"), "test");
    assert.equal(kind("checks_area"), "test");
    assert.equal(kind("bench_square"), "bench");
    assert.equal(kind("make"), "helper");
    assert.equal(kind("area_of_square"), undefined);
    const tests = result.nodes.find((candidate) => candidate.label === "File" && candidate.properties.relativePath === "src/tests.rs")!;
    assert.equal(tests.properties.isTest, true);
  });
});
