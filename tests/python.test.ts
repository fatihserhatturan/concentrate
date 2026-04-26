import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { pythonParser } from "../src/parsers/python.js";

const fixtureRoot = path.resolve("fixtures/parser-python");
const fixturePath = path.join(fixtureRoot, "module.py");

describe("Python parser", () => {
  it("extracts file node with correct language", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    const file = result.nodes.find((n) => n.label === "File");
    assert.ok(file);
    assert.equal(file.properties.language, "python");
  });

  it("extracts import", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    const imports = result.nodes.filter((n) => n.label === "Import");
    assert.equal(imports.length, 1);
    assert.equal(imports[0]!.properties.source, "os");
  });

  it("extracts exported function (no underscore prefix)", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "greet");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
    assert.equal(fn.properties.className, null);
  });

  it("extracts async function", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetch");
    assert.ok(fn);
    assert.equal(fn.properties.isAsync, true);
    assert.equal(fn.properties.isExported, true);
  });

  it("marks private function as not exported", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "_private");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, false);
  });

  it("extracts class with isExported=true", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService");
    assert.ok(cls);
    assert.equal(cls.properties.isExported, true);
  });

  it("attributes methods to class via DEFINES_METHOD", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService")!;
    const getMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "get_name");
    const fetchMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetch_user");
    const helperMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "_helper");
    assert.ok(getMethod);
    assert.ok(fetchMethod);
    assert.ok(helperMethod);
    assert.equal(getMethod.properties.className, "UserService");
    assert.equal(fetchMethod.properties.className, "UserService");
    assert.equal(getMethod.properties.isAsync, false);
    assert.equal(fetchMethod.properties.isAsync, true);
    assert.equal(helperMethod.properties.isExported, false);
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === getMethod.id && r.type === "DEFINES_METHOD"));
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === fetchMethod.id && r.type === "DEFINES_METHOD"));
  });

  it("does not emit DEFINES_FUNCTION for class methods", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    const getMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "get_name")!;
    assert.ok(!result.relationships.some((r) => r.to === getMethod.id && r.type === "DEFINES_FUNCTION"));
  });

  it("total node counts are correct", async () => {
    const result = await pythonParser.parse(fixtureRoot, fixturePath);
    assert.equal(result.nodes.filter((n) => n.label === "Function").length, 6);
    assert.equal(result.nodes.filter((n) => n.label === "Class").length, 1);
    assert.equal(result.nodes.filter((n) => n.label === "Import").length, 1);
  });
});
