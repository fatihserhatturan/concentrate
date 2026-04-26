import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { typescriptParser } from "../src/parsers/javascript-like.js";

const fixtureRoot = path.resolve("fixtures/parser-typescript");
const fixturePath = path.join(fixtureRoot, "index.ts");

describe("TypeScript parser", () => {
  it("extracts file node with correct language", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const file = result.nodes.find((n) => n.label === "File");
    assert.ok(file);
    assert.equal(file.properties.language, "typescript");
  });

  it("extracts exported function declaration", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "greet");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
    assert.equal(fn.properties.kind, "function_declaration");
  });

  it("extracts exported arrow function", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "add");
    assert.ok(fn);
    assert.equal(fn.properties.kind, "arrow_function");
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
  });

  it("extracts exported async arrow function", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetchData");
    assert.ok(fn);
    assert.equal(fn.properties.kind, "arrow_function");
    assert.equal(fn.properties.isAsync, true);
    assert.equal(fn.properties.isExported, true);
  });

  it("extracts non-exported arrow function", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "_internal");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, false);
  });

  it("extracts exported class", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService");
    assert.ok(cls);
    assert.equal(cls.properties.isExported, true);
  });

  it("attributes methods to class via DEFINES_METHOD", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService")!;
    const getMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "getName");
    const fetchMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetchUser");
    assert.ok(getMethod);
    assert.ok(fetchMethod);
    assert.equal(getMethod.properties.className, "UserService");
    assert.equal(fetchMethod.properties.className, "UserService");
    assert.equal(getMethod.properties.isAsync, false);
    assert.equal(fetchMethod.properties.isAsync, true);
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === getMethod.id && r.type === "DEFINES_METHOD"));
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === fetchMethod.id && r.type === "DEFINES_METHOD"));
  });

  it("does not emit DEFINES_FUNCTION for class methods", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const getMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "getName")!;
    assert.ok(!result.relationships.some((r) => r.to === getMethod.id && r.type === "DEFINES_FUNCTION"));
  });
});
