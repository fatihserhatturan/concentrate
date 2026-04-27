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

  it("extracts module-level variable declarations and skips function-valued ones", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);

    const vars = result.nodes.filter((n) => n.label === "Variable");
    assert.equal(vars.length, 3, "Expected 3 Variable nodes");

    const maxSize = vars.find((v) => v.properties.name === "MAX_SIZE")!;
    assert.ok(maxSize, "MAX_SIZE variable");
    assert.equal(maxSize.properties.kind, "const");
    assert.equal(maxSize.properties.isExported, true);
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === maxSize.id && r.type === "DEFINES_VARIABLE"));

    const defaultName = vars.find((v) => v.properties.name === "defaultName")!;
    assert.ok(defaultName, "defaultName variable");
    assert.equal(defaultName.properties.kind, "let");
    assert.equal(defaultName.properties.isExported, true);

    const globalFlag = vars.find((v) => v.properties.name === "globalFlag")!;
    assert.ok(globalFlag, "globalFlag variable");
    assert.equal(globalFlag.properties.kind, "var");
    assert.equal(globalFlag.properties.isExported, false);

    // Arrow functions and function expressions must NOT produce Variable nodes
    assert.equal(vars.find((v) => v.properties.name === "add"), undefined, "add is an arrow fn, not a Variable");
    assert.equal(vars.find((v) => v.properties.name === "compute"), undefined, "compute is a fn expression, not a Variable");
    assert.equal(vars.find((v) => v.properties.name === "_internal"), undefined, "_internal is an arrow fn, not a Variable");
  });

  it("extracts parameters without types and null returnType for JavaScript functions", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);

    const greet = result.nodes.find((n) => n.label === "Function" && n.properties.name === "greet")!;
    assert.deepEqual(JSON.parse(greet.properties.parameters as string), [
      { name: "name", type: null },
    ]);
    assert.equal(greet.properties.returnType, null);

    const add = result.nodes.find((n) => n.label === "Function" && n.properties.name === "add")!;
    assert.deepEqual(JSON.parse(add.properties.parameters as string), [
      { name: "a", type: null },
      { name: "b", type: null },
    ]);
    assert.equal(add.properties.returnType, null);

    const internal = result.nodes.find((n) => n.label === "Function" && n.properties.name === "_internal")!;
    assert.deepEqual(JSON.parse(internal.properties.parameters as string), []);
    assert.equal(internal.properties.returnType, null);
  });
});
