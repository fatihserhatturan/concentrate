import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { javascriptParser } from "../src/integrations/frameworks/js-ts/scanner.js";

const fixtureRoot = path.resolve("fixtures/parser-javascript");
const fixturePath = path.join(fixtureRoot, "index.js");
const classExpressionRoot = path.resolve("fixtures/class-expression");
const classExpressionPath = path.join(classExpressionRoot, "javascript.js");
const commonJsExportRoot = path.resolve("fixtures/commonjs-exports");
const commonJsExportPath = path.join(commonJsExportRoot, "index.js");

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
    assert.equal(sumMethod.properties.methodKind, "method");
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

  it("tracks getter and setter method kinds", async () => {
    const result = await javascriptParser.parse(fixtureRoot, fixturePath);

    const resultMethods = result.nodes.filter((n) => n.label === "Function" && n.properties.name === "result");
    assert.equal(resultMethods.length, 2);
    assert.ok(resultMethods.some((method) => method.properties.methodKind === "get"));
    assert.ok(resultMethods.some((method) => method.properties.methodKind === "set"));
  });

  it("extracts class expressions assigned to variables as classes", async () => {
    const result = await javascriptParser.parse(classExpressionRoot, classExpressionPath);

    const inlineService = result.nodes.find((n) => n.label === "Class" && n.properties.name === "InlineService")!;
    const localWorker = result.nodes.find((n) => n.label === "Class" && n.properties.name === "LocalWorker")!;
    assert.ok(inlineService, "InlineService class expression");
    assert.ok(localWorker, "LocalWorker class expression");
    assert.equal(inlineService.properties.isExported, true);
    assert.equal(localWorker.properties.isExported, false);
    assert.deepEqual(JSON.parse(inlineService.properties.extendsNames as string), ["BaseService"]);
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === inlineService.id && r.type === "DEFINES_CLASS"));
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === localWorker.id && r.type === "DEFINES_CLASS"));
    assert.equal(result.nodes.find((n) => n.label === "Variable" && n.properties.name === "InlineService"), undefined);
    assert.equal(result.nodes.find((n) => n.label === "Variable" && n.properties.name === "LocalWorker"), undefined);
  });

  it("extracts members and calls from JavaScript class expressions", async () => {
    const result = await javascriptParser.parse(classExpressionRoot, classExpressionPath);
    const inlineService = result.nodes.find((n) => n.label === "Class" && n.properties.name === "InlineService")!;

    const cache = result.nodes.find((n) => n.label === "Field" && n.properties.name === "cache")!;
    const find = result.nodes.find((n) => n.label === "Function" && n.properties.name === "find")!;
    assert.ok(cache, "cache field");
    assert.ok(find, "find method");
    assert.equal(find.properties.className, "InlineService");
    assert.ok(result.relationships.some((r) => r.from === inlineService.id && r.to === cache.id && r.type === "DEFINES_FIELD"));
    assert.ok(result.relationships.some((r) => r.from === inlineService.id && r.to === find.id && r.type === "DEFINES_METHOD"));
    assert.ok(!result.relationships.some((r) => r.to === find.id && r.type === "DEFINES_FUNCTION"));
    assert.ok(result.relationships.some((r) => {
      const target = result.nodes.find((n) => n.id === r.to);
      return r.from === find.id && r.type === "CALLS" && target?.properties.expression === "helper";
    }));
  });

  it("marks module.exports object shorthand bindings as exported", async () => {
    const result = await javascriptParser.parse(commonJsExportRoot, commonJsExportPath);

    const createClient = result.nodes.find((n) => n.label === "Function" && n.properties.name === "createClient")!;
    const clientFactory = result.nodes.find((n) => n.label === "Class" && n.properties.name === "ClientFactory")!;
    const defaultTimeout = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "defaultTimeout")!;
    const internalOnly = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "internalOnly")!;

    assert.ok(createClient);
    assert.ok(clientFactory);
    assert.ok(defaultTimeout);
    assert.ok(internalOnly);
    assert.equal(createClient.properties.isExported, true);
    assert.equal(clientFactory.properties.isExported, true);
    assert.equal(defaultTimeout.properties.isExported, true);
    assert.equal(internalOnly.properties.isExported, false);
  });

  it("creates exported variables for module.exports object keys and property assignments", async () => {
    const result = await javascriptParser.parse(commonJsExportRoot, commonJsExportPath);

    const name = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "name")!;
    const make = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "make")!;
    const extra = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "extra")!;
    const direct = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "direct")!;
    const assignedName = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "assignedName")!;

    assert.ok(name);
    assert.ok(make);
    assert.ok(extra);
    assert.ok(direct);
    assert.ok(assignedName);
    assert.equal(name.properties.kind, "module.exports");
    assert.equal(make.properties.kind, "module.exports");
    assert.equal(extra.properties.kind, "module.exports");
    assert.equal(direct.properties.kind, "module.exports");
    assert.equal(assignedName.properties.kind, "module.exports");
    assert.equal(name.properties.isExported, true);
    assert.equal(make.properties.isExported, true);
    assert.equal(extra.properties.isExported, true);
    assert.equal(direct.properties.isExported, true);
    assert.equal(assignedName.properties.isExported, true);
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === name.id && r.type === "DEFINES_VARIABLE"));
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === make.id && r.type === "DEFINES_VARIABLE"));
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === extra.id && r.type === "DEFINES_VARIABLE"));
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === direct.id && r.type === "DEFINES_VARIABLE"));
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === assignedName.id && r.type === "DEFINES_VARIABLE"));
  });
});
