import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { goParser } from "../src/parsers/go.js";

const fixtureRoot = path.resolve("fixtures/parser-go");
const fixturePath = path.join(fixtureRoot, "service.go");

describe("Go parser", () => {
  it("extracts file node with correct language", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const file = result.nodes.find((n) => n.label === "File");
    assert.ok(file);
    assert.equal(file.properties.language, "go");
  });

  it("extracts imports", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const imports = result.nodes.filter((n) => n.label === "Import");
    const sources = imports.map((n) => n.properties.source).sort();
    assert.deepEqual(sources, ["fmt", "strings"]);
  });

  it("extracts exported struct", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService");
    assert.ok(cls);
    assert.equal(cls.properties.isExported, true);
  });

  it("extracts exported free function", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "NewUserService");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
    assert.equal(fn.properties.className, null);
  });

  it("marks lowercase function as not exported", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "internalHelper");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, false);
  });

  it("attributes methods to struct via DEFINES_METHOD", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService")!;
    const getName = result.nodes.find((n) => n.label === "Function" && n.properties.name === "GetName");
    const print = result.nodes.find((n) => n.label === "Function" && n.properties.name === "Print");
    assert.ok(getName);
    assert.ok(print);
    assert.equal(getName.properties.className, "UserService");
    assert.equal(print.properties.className, "UserService");
    assert.equal(getName.properties.isExported, true);
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === getName.id && r.type === "DEFINES_METHOD"));
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === print.id && r.type === "DEFINES_METHOD"));
  });

  it("emits DEFINES_FUNCTION for free functions, not methods", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const newFn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "NewUserService")!;
    const getName = result.nodes.find((n) => n.label === "Function" && n.properties.name === "GetName")!;
    assert.ok(result.relationships.some((r) => r.to === newFn.id && r.type === "DEFINES_FUNCTION"));
    assert.ok(!result.relationships.some((r) => r.to === getName.id && r.type === "DEFINES_FUNCTION"));
  });

  it("records calls inside free functions", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const newFn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "NewUserService")!;
    const calls = result.relationships
      .filter((r) => r.from === newFn.id && r.type === "CALLS")
      .map((r) => result.nodes.find((n) => n.id === r.to)!.properties.expression);
    assert.ok(calls.includes("strings.TrimSpace"));
  });

  it("total node counts are correct", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    assert.equal(result.nodes.filter((n) => n.label === "Function").length, 4);
    assert.equal(result.nodes.filter((n) => n.label === "Class").length, 1);
  });
});
