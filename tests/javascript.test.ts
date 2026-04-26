import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { javascriptParser } from "../src/parsers/javascript-like.js";

const fixtureRoot = path.resolve("fixtures/parser-javascript");
const fixturePath = path.join(fixtureRoot, "index.js");

describe("JavaScript parser", () => {
  it("extracts file node with correct language", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const file = result.nodes.find((n) => n.label === "File");
    assert.ok(file);
    assert.equal(file.properties.language, "javascript");
  });

  it("extracts import", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const imports = result.nodes.filter((n) => n.label === "Import");
    assert.equal(imports.length, 1);
    assert.equal(imports[0]!.properties.source, "./utils.js");
  });

  it("extracts exported function declaration", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "greet");
    assert.ok(fn);
    assert.equal(fn.properties.kind, "function_declaration");
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
    assert.equal(fn.properties.className, null);
    assert.equal(fn.properties.visibility, "public");
  });

  it("extracts exported arrow function", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "add");
    assert.ok(fn);
    assert.equal(fn.properties.kind, "arrow_function");
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
  });

  it("extracts exported async function expression", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "compute");
    assert.ok(fn);
    assert.equal(fn.properties.kind, "function_expression");
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, true);
  });

  it("extracts non-exported arrow function", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "_internal");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, false);
  });

  it("extracts exported class with isExported=true", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "Calculator");
    assert.ok(cls);
    assert.equal(cls.properties.isExported, true);
    assert.equal(cls.properties.visibility, "public");
  });

  it("attributes methods to class via DEFINES_METHOD", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "Calculator")!;
    const sumMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "sum");
    const fetchMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetchResult");
    assert.ok(sumMethod);
    assert.ok(fetchMethod);
    assert.equal(sumMethod.properties.className, "Calculator");
    assert.equal(fetchMethod.properties.className, "Calculator");
    assert.equal(fetchMethod.properties.isAsync, true);
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === sumMethod.id && r.type === "DEFINES_METHOD"));
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === fetchMethod.id && r.type === "DEFINES_METHOD"));
  });

  it("does not emit DEFINES_FUNCTION for class methods", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const sumMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "sum")!;
    assert.ok(!result.relationships.some((r) => r.to === sumMethod.id && r.type === "DEFINES_FUNCTION"));
  });

  it("records calls inside functions", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);
    const greet = result.nodes.find((n) => n.label === "Function" && n.properties.name === "greet")!;
    const calls = result.relationships
      .filter((r) => r.from === greet.id && r.type === "CALLS")
      .map((r) => result.nodes.find((n) => n.id === r.to)!.properties.expression);
    assert.deepEqual(calls.sort(), ["helper"]);
  });
});
