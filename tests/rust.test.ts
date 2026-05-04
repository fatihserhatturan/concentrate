import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { rustParser } from "../src/integrations/languages/rust/parser.js";

const fixtureRoot = path.resolve("fixtures/parser-rust");
const fixturePath = path.join(fixtureRoot, "lib.rs");

describe("Rust parser", () => {
  it("extracts file node with correct language", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const file = result.nodes.find((n) => n.label === "File");
    assert.ok(file);
    assert.equal(file.properties.language, "rust");
  });

  it("extracts pub struct as exported class", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService");
    assert.ok(cls);
    assert.equal(cls.properties.isExported, true);
    assert.equal(cls.properties.visibility, "pub");
  });

  it("extracts private struct as not exported", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "Internal");
    assert.ok(cls);
    assert.equal(cls.properties.isExported, false);
    assert.equal(cls.properties.visibility, "private");
  });

  it("extracts scoped pub visibility on structs", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "CrateVisible");
    assert.ok(cls);
    assert.equal(cls.properties.isExported, true);
    assert.equal(cls.properties.visibility, "pub(crate)");
  });

  it("extracts pub fn as exported", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "create");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
    assert.equal(fn.properties.className, null);
    assert.equal(fn.properties.visibility, "pub");
  });

  it("extracts async fn", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "process");
    assert.ok(fn);
    assert.equal(fn.properties.isAsync, true);
    assert.equal(fn.properties.isExported, false);
    assert.equal(fn.properties.visibility, "private");
  });

  it("extracts private fn as not exported", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "internal");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, false);
    assert.equal(fn.properties.isAsync, false);
    assert.equal(fn.properties.visibility, "private");
  });

  it("extracts scoped pub visibility on functions", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "parent_visible");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.visibility, "pub(super)");
  });

  it("attributes impl methods to struct via DEFINES_METHOD", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService")!;
    const newMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "new");
    const fetchMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetch");
    const helperMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "helper");
    assert.ok(newMethod);
    assert.ok(fetchMethod);
    assert.ok(helperMethod);
    assert.equal(newMethod.properties.className, "UserService");
    assert.equal(fetchMethod.properties.className, "UserService");
    assert.equal(helperMethod.properties.className, "UserService");
    assert.equal(newMethod.properties.isExported, true);
    assert.equal(newMethod.properties.visibility, "pub");
    assert.equal(fetchMethod.properties.isAsync, true);
    assert.equal(fetchMethod.properties.isExported, true);
    assert.equal(helperMethod.properties.isExported, false);
    assert.equal(helperMethod.properties.visibility, "private");
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === newMethod.id && r.type === "DEFINES_METHOD"));
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === fetchMethod.id && r.type === "DEFINES_METHOD"));
  });

  it("emits DEFINES_FUNCTION for free functions, not impl methods", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    const createFn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "create")!;
    const newMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "new")!;
    assert.ok(result.relationships.some((r) => r.to === createFn.id && r.type === "DEFINES_FUNCTION"));
    assert.ok(!result.relationships.some((r) => r.to === newMethod.id && r.type === "DEFINES_FUNCTION"));
  });

  it("total node counts are correct", async () => {
    const result = await rustParser.parse(fixtureRoot, fixturePath);
    assert.equal(result.nodes.filter((n) => n.label === "Function").length, 7);
    assert.equal(result.nodes.filter((n) => n.label === "Class").length, 3);
  });
});
