import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { goParser } from "../src/integrations/languages/go/parser.js";
import { goPackageDirectory, readGoResolutionConfig } from "../src/integrations/languages/go/resolution.js";

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
    assert.equal(cls.properties.visibility, "exported");
  });

  it("extracts exported free function", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "NewUserService");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
    assert.equal(fn.properties.className, null);
    assert.equal(fn.properties.visibility, "exported");
  });

  it("marks lowercase function as not exported", async () => {
    const result = await goParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "internalHelper");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, false);
    assert.equal(fn.properties.visibility, "unexported");
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

  it("records the package, signatures, struct fields and import aliases", async () => {
    const root = path.resolve("fixtures/go-workspace");
    const handler = await goParser.parse(root, path.join(root, "api/internal/handler/handler.go"));
    assert.equal(handler.nodes.find((n) => n.label === "File")!.properties.packageName, "handler");
    const newFn = handler.nodes.find((n) => n.label === "Function" && n.properties.name === "New")!;
    assert.equal(newFn.properties.parameters, JSON.stringify([{ name: "repo", type: "*store.Repo" }]));
    assert.equal(newFn.properties.returnType, "*Handler");
    const struct = handler.nodes.find((n) => n.label === "Class" && n.properties.name === "Handler")!;
    assert.deepEqual(JSON.parse(String(struct.properties.fields)), [
      { name: "Base", type: "Base", embedded: true },
      { name: "repo", type: "*store.Repo" },
    ]);

    const main = await goParser.parse(root, path.join(root, "api/cmd/server/main.go"));
    const aliases = main.nodes.filter((n) => n.label === "Import").map((n) => [n.properties.source, n.properties.alias ?? null]);
    assert.deepEqual(aliases, [["log", null], ["example.com/api/internal/handler", null], ["example.com/store", "db"], ["github.com/lib/pq", "_"]]);
  });

  it("types call receivers from the function's scope", async () => {
    const root = path.resolve("fixtures/go-workspace");
    const main = await goParser.parse(root, path.join(root, "api/cmd/server/main.go"));
    const serve = main.nodes.find((n) => n.label === "Call" && n.properties.expression === "h.Serve")!;
    assert.equal(serve.properties.receiverConstructor, "handler.New");
    const handler = await goParser.parse(root, path.join(root, "api/internal/handler/handler.go"));
    const find = handler.nodes.find((n) => n.label === "Call" && n.properties.expression === "h.repo.Find")!;
    assert.equal(find.properties.receiverType, "*Handler");
    // A range variable hides the `store` package.
    const close = handler.nodes.find((n) => n.label === "Call" && n.properties.expression === "store.Close")!;
    assert.equal(close.properties.receiverIsLocal, true);
  });
});

describe("Go modules", () => {
  it("reads nested modules, go.work and local replace directives", async () => {
    const root = path.resolve("fixtures/go-workspace");
    const config = await readGoResolutionConfig(root, ["api/cmd/server/main.go", "store/repo.go", "util/strings.go"]);
    assert.deepEqual(config.modules, [
      { path: "example.com/util/v2", dir: "util" },
      { path: "example.com/store", dir: "store" },
      { path: "example.com/util", dir: "util" },
      { path: "example.com/api", dir: "api" },
    ]);
    assert.equal(goPackageDirectory("example.com/api/internal/handler", config), "api/internal/handler");
    assert.equal(goPackageDirectory("example.com/store", config), "store");
    assert.equal(goPackageDirectory("example.com/apix", config), null);
    assert.equal(goPackageDirectory("github.com/lib/pq", config), null);
  });
});
