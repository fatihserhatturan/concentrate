import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { normalizeCppType } from "../src/integrations/languages/cpp/types.js";
import { detectLanguage } from "../src/core/scan/language.js";
import { filterSupportedSourceFiles } from "../src/core/scan/source-files.js";
import { classifyFile } from "../src/core/scan/file-classification.js";

type Scan = Awaited<ReturnType<typeof buildCodeGraph>>;

async function scan(fixture: string): Promise<Scan> {
  return buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: true, concurrency: 2 });
}

// Every call as `file:line expression` → resolved targets as `file#qualified[ via]`.
function callTargets(result: Scan): (key: string) => string[] {
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  const owner = new Map<string, string>();
  for (const relationship of result.relationships) if (relationship.type === "CALLS") owner.set(relationship.to, relationship.from);
  const targets = new Map<string, string[]>();
  for (const node of result.nodes) {
    if (node.label === "Call") targets.set(`${owner.get(node.id)!.split(":function:")[0]!.replace(/^file:/u, "")}:${node.properties.line} ${node.properties.expression}`, []);
  }
  for (const relationship of result.relationships) {
    if (relationship.type !== "CALL_RESOLVES_TO") continue;
    const call = byId.get(relationship.from)!;
    const target = byId.get(relationship.to)!;
    const key = `${owner.get(call.id)!.split(":function:")[0]!.replace(/^file:/u, "")}:${call.properties.line} ${call.properties.expression}`;
    const file = relationship.to.replace(/^file:/u, "").split(":function:")[0];
    targets.get(key)!.push(`${file}#${target.properties.qualifiedName}${relationship.properties.via ? ` ${relationship.properties.via}` : ""}`);
  }
  return (key) => (targets.get(key) ?? ["<missing call>"]).slice().sort();
}

describe("C and C++ languages", () => {
  it("maps extensions and reads .h as C++ only when the project has C++ sources", () => {
    for (const [file, language] of [["a.c", "c"], ["a.cc", "cpp"], ["a.cpp", "cpp"], ["a.cxx", "cpp"], ["a.hpp", "cpp"], ["a.hh", "cpp"], ["a.hxx", "cpp"], ["a.ipp", "cpp"], ["a.inl", "cpp"], ["a.h", "c"]] as const) {
      assert.equal(detectLanguage(file), language, file);
    }
    assert.deepEqual(filterSupportedSourceFiles(["/p/a.h", "/p/a.c"], undefined).map((file) => file.language), ["c", "c"]);
    assert.deepEqual(filterSupportedSourceFiles(["/p/a.h", "/p/a.cpp"], undefined).map((file) => file.language), ["cpp", "cpp"]);
  });

  it("normalizes written types to the name a class would have", () => {
    assert.equal(normalizeCppType("const ns::Foo<int>&"), "ns::Foo");
    assert.equal(normalizeCppType("std::unique_ptr<geo::Shape>"), "geo::Shape");
    assert.equal(normalizeCppType("struct Node *"), "Node");
    assert.equal(normalizeCppType("auto"), null);
    assert.equal(normalizeCppType("unsigned int"), null);
  });

  it("classifies C and C++ test files", () => {
    for (const file of ["a/foo_test.cc", "a/foo_unittest.cpp", "a/test_foo.c", "a/FooTest.cpp", "tests/x.cpp"]) assert.equal(classifyFile(file).isTest, true, file);
    assert.equal(classifyFile("src/latest.cpp").isTest, false);
    assert.equal(classifyFile("src/x.cpp", false, true, true).isTest, true);
  });
});

describe("C++ declarations and calls (fixtures/cpp-calls)", () => {
  let result: Scan;
  let at: (key: string) => string[];
  before(async () => {
    result = await scan("cpp-calls");
    at = callTargets(result);
  });

  it("records classes with bases, namespaces, virtual and override", () => {
    const circle = result.nodes.find((node) => node.label === "Class" && node.properties.qualifiedName === "geo::Circle")!;
    assert.deepEqual(JSON.parse(String(circle.properties.bases)), [{ name: "Shape", access: "public", virtual: false }]);
    const area = result.nodes.find((node) => node.label === "Function" && node.properties.qualifiedName === "geo::Circle::area" && node.properties.isDeclaration === true)!;
    assert.equal(area.properties.isOverride, true);
    assert.equal(area.properties.isVirtual, true);
    const pure = result.nodes.find((node) => node.properties.qualifiedName === "geo::Shape::area")!;
    assert.equal(pure.properties.isAbstract, true);
    assert.equal(result.nodes.find((node) => node.label === "Class" && node.properties.qualifiedName === "geo::Shape")!.properties.isAbstract, true);
    const extendsPairs = result.relationships.filter((relationship) => relationship.type === "EXTENDS").map((relationship) => relationship.from.split(":class:")[1]!.split(":").slice(1).join(":") + ">" + relationship.to.split(":class:")[1]!.split(":").slice(1).join(":"));
    assert.deepEqual(extendsPairs.sort(), ["geo::Circle>geo::Shape", "geo::Square>geo::Shape"]);
  });

  it("records macros as functions and variables, and #include imports", () => {
    assert.ok(result.nodes.some((node) => node.label === "Function" && node.properties.kind === "macro" && node.properties.name === "CLAMP"));
    assert.ok(result.nodes.some((node) => node.label === "Variable" && node.properties.kind === "macro" && node.properties.name === "MAX_SHAPES"));
    const imports = result.nodes.filter((node) => node.label === "Import" && String(node.properties.specifier).includes("memory"));
    assert.equal(imports[0]!.properties.isSystem, true);
  });

  it("links a declaration in a header to its definition in a source file", () => {
    const pairs = result.relationships.filter((relationship) => relationship.type === "DEFINED_BY").map((relationship) => `${relationship.from.replace(/^file:/u, "").replace(":function:", "@")} -> ${relationship.to.replace(/^file:/u, "").replace(":function:", "@")}`);
    assert.ok(pairs.includes("include/geo/shape.h@17:geo::Circle::area -> src/shape.cpp@15:geo::Circle::area"));
    assert.ok(pairs.includes("include/geo/shape.h@33:geo::total_area -> src/shape.cpp@19:geo::total_area"));
    assert.equal(pairs.filter((pair) => pair.includes("log_line")).length, 2);
  });

  it("resolves free, qualified and using-declared calls through the header to the definition", () => {
    assert.deepEqual(at("src/main.cpp:37 total_area"), ["src/shape.cpp#geo::total_area header"]);
    assert.deepEqual(at("src/main.cpp:38 geo::total_area"), ["src/shape.cpp#geo::total_area header"]);
    assert.deepEqual(at("src/main.cpp:39 util::log_line"), ["src/util.cpp#geo::util::log_line header"]);
    assert.deepEqual(at("src/main.cpp:40 clamp_count"), ["src/util.cpp#geo::util::clamp_count header"]);
    assert.deepEqual(at("src/util.cpp:5 CLAMP"), ["include/geo/util.h#CLAMP macro"]);
    assert.deepEqual(at("src/util.cpp:7 bounded"), ["src/util.cpp#geo::util::bounded"]);
  });

  it("picks the overload by argument count", () => {
    assert.deepEqual(at("src/shape.cpp:9 util::log_line"), ["src/util.cpp#geo::util::log_line header"]);
    assert.deepEqual(at("src/shape.cpp:10 util::log_line"), ["src/util.cpp#geo::util::log_line header"]);
    assert.deepEqual(at("src/util.cpp:9 log_line"), ["src/util.cpp#geo::util::log_line header"]);
  });

  it("resolves methods on typed receivers (T x, T* p, T& r, auto = new / make_unique, fields)", () => {
    assert.deepEqual(at("src/main.cpp:32 registry.add"), ["src/main.cpp#Registry::add"]);
    assert.deepEqual(at("src/main.cpp:42 registry.sum"), ["src/main.cpp#Registry::sum"]);
    assert.deepEqual(at("src/main.cpp:36 raw->name"), ["src/shape.cpp#geo::Circle::name virtual"]);
    assert.deepEqual(at("src/main.cpp:17 favourite.area"), ["src/shape.cpp#geo::Circle::area virtual"]);
    assert.deepEqual(at("src/shape.cpp:9 name"), ["src/shape.cpp#geo::Circle::name override", "src/shape.cpp#geo::Shape::name virtual"]);
  });

  it("makes a virtual call reach the base and every override, marked", () => {
    const expected = ["include/geo/shape.h#geo::Shape::area virtual", "include/geo/shape.h#geo::Square::area override", "src/shape.cpp#geo::Circle::area override"];
    assert.deepEqual(at("src/main.cpp:23 shape->area"), expected);
    assert.deepEqual(at("src/main.cpp:35 ref.area"), expected);
    assert.deepEqual(at("src/shape.cpp:19 a.area"), expected);
    assert.deepEqual(at("src/main.cpp:22 shape->describe"), ["src/shape.cpp#geo::Shape::describe header"]);
  });

  it("leaves calls outside the project unresolved", () => {
    assert.deepEqual(at("src/main.cpp:32 std::move"), []);
  });

  it("marks main as an entrypoint", () => {
    const entrypoint = result.nodes.find((node) => node.label === "EntryPoint")!;
    assert.equal(entrypoint.properties.kind, "main");
    assert.equal(entrypoint.properties.library, "cpp");
  });
});

describe("C (fixtures/c-basic)", () => {
  it("reads typedef'd structs, enums and macros, and resolves calls through the header", async () => {
    const result = await scan("c-basic");
    const at = callTargets(result);
    assert.deepEqual(result.nodes.filter((node) => node.label === "Class").map((node) => `${node.properties.name}:${node.properties.kind}`).sort(), ["List:struct", "Node:struct"]);
    assert.ok(result.nodes.some((node) => node.label === "TypeAlias" === false && node.label === "Enum" && node.properties.name === "ListError"));
    assert.deepEqual(at("src/main.c:10 list_push"), ["src/list.c#list_push header"]);
    assert.deepEqual(at("src/main.c:5 list_sum"), ["src/list.c#list_sum header"]);
    assert.deepEqual(at("src/main.c:12 LIST_EMPTY"), ["include/list.h#LIST_EMPTY macro"]);
    assert.deepEqual(at("src/list.c:12 make_node"), ["src/list.c#make_node"]);
    assert.equal(result.nodes.find((node) => node.label === "EntryPoint")!.properties.library, "c");
    assert.equal(result.nodes.find((node) => node.label === "Function" && node.properties.name === "make_node")!.properties.isExported, false);
  });
});

describe("includes (fixtures/cpp-includes)", () => {
  it("resolves quoted includes by file, then compile_commands.json; external <…> headers stay unresolved and uncounted", async () => {
    const result = await scan("cpp-includes");
    const resolved = result.relationships.filter((relationship) => relationship.type === "RESOLVES_TO" && relationship.from.includes(":import:")).map((relationship) => `${relationship.from.replace(/^file:/u, "")} -> ${relationship.to.replace(/^file:/u, "")}`).sort();
    assert.deepEqual(resolved, [
      "src/config.cpp:import:1:app/config.h -> include/app/config.h",
      "src/config.cpp:import:2:fmt/format.h -> third_party/fmt/format.h",
      "src/main.cpp:import:1:app/config.h -> include/app/config.h",
      "src/main.cpp:import:2:../include/app/config.h -> include/app/config.h",
    ]);
    // `"missing/nothing.h"` is the only include the project cannot place.
    assert.equal(result.report.unresolvedRelativeImports, 1);
    assert.deepEqual(callTargets(result)("src/main.cpp:4 app::version"), ["src/config.cpp#app::version header"]);
    assert.deepEqual(callTargets(result)("src/config.cpp:7 fmt::pad"), ["third_party/fmt/format.h#fmt::pad"]);
  });
});

describe("tests (fixtures/cpp-tests)", () => {
  it("classifies GoogleTest and Catch2 files and functions as tests", async () => {
    const result = await scan("cpp-tests");
    const tests = result.nodes.filter((node) => node.label === "Function" && node.properties.kind === "test").map((node) => `${node.properties.testKind}:${node.properties.name}`).sort();
    assert.deepEqual(tests, ["catch2:calc adds", "catch2:doubling", "gtest:CalcFixture.Doubles", "gtest:CalcParam.Many", "gtest:CalcSuite.Adds"]);
    const files = result.nodes.filter((node) => node.label === "File" && node.properties.language === "cpp").map((node) => `${node.properties.relativePath}:${node.properties.isTest}`).sort();
    assert.deepEqual(files, ["src/calc.cpp:false", "src/calc.h:false", "tests/calc_catch.cpp:true", "tests/calc_gtest.cc:true"]);
    const at = callTargets(result);
    assert.deepEqual(at("tests/calc_catch.cpp:6 add"), ["src/calc.cpp#add header"]);
    assert.deepEqual(at("tests/calc_gtest.cc:7 twice"), ["src/calc.cpp#twice header"]);
  });
});

describe("syntax errors (fixtures/cpp-syntax-error)", () => {
  it("keeps a partial graph and warns about the statements left out", async () => {
    const result = await scan("cpp-syntax-error");
    assert.deepEqual(result.report.failedFiles, []);
    assert.deepEqual(result.report.warnings.map((warning) => `${warning.path}: ${warning.message}`), ["broken.cpp: Syntax error: left out the statements at lines 5, 8"]);
    const names = result.nodes.filter((node) => node.label === "Function" && node.id.includes("broken.cpp")).map((node) => node.properties.name);
    assert.deepEqual(names, ["before", "DECLARE_HANDLER", "after"]);
  });
});
