import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { detectLanguage } from "../src/core/scan/language.js";
import { readCMake } from "../src/integrations/languages/plain/cmake.js";

type Scan = Awaited<ReturnType<typeof buildCodeGraph>>;

async function scan(directory: string): Promise<Scan> {
  return buildCodeGraph(path.resolve(directory), { continueOnError: true, concurrency: 2 });
}

const strip = (id: string) => id.replace(/^file:/u, "");

function targets(result: Scan): string[] {
  const names = new Map(result.nodes.map((node) => [node.id, node]));
  return result.nodes.filter((node) => node.label === "Package" && node.properties.manager !== undefined && (node.properties.manager === "cmake" || node.properties.manager === "make")).map((node) => {
    const files = result.relationships.filter((rel) => rel.type === "PACKAGE_CONTAINS_FILE" && rel.from === node.id).map((rel) => strip(rel.to)).sort();
    const links = result.relationships.filter((rel) => rel.type === "PACKAGE_IMPORTS_PACKAGE" && rel.from === node.id).map((rel) => String(names.get(rel.to)!.properties.name)).sort();
    return `${node.properties.manager}:${node.properties.name} ${node.properties.targetType} [${files.join(",")}] -> [${links.join(",")}] unresolved=${node.properties.unresolved}`;
  }).sort();
}

function resolvedIncludes(result: Scan): string[] {
  return result.relationships.filter((rel) => rel.type === "RESOLVES_TO" && rel.from.includes(":import:")).map((rel) => `${strip(rel.from)} -> ${strip(rel.to)}`).sort();
}

describe("CMake reader", () => {
  it("splits commands and arguments, skipping comments and reading quotes and bracket arguments", () => {
    const read = readCMake(`# comment
Add_Executable(app  main.cpp # trailing
  "src dir/a.cpp" [[raw ${"$"}{x}]]
)
#[[ block
comment ]]
set(V a b)
if((A AND B))
endif()
`);
    assert.deepEqual(read.errors, []);
    assert.deepEqual(read.commands.map((command) => `${command.name}:${command.line}`), ["add_executable:2", "set:7", "if:8", "endif:9"]);
    assert.deepEqual(read.commands[0]!.args.map((arg) => [arg.text, arg.quoted, arg.bracket]), [["app", false, false], ["main.cpp", false, false], ["src dir/a.cpp", true, false], ["raw ${x}", true, true]]);
  });

  it("reports a command whose parenthesis never closes, and detects the files as cmake", () => {
    assert.equal(readCMake("add_library(a a.cpp\n").errors.length, 1);
    assert.equal(detectLanguage("a/CMakeLists.txt"), "cmake");
    assert.equal(detectLanguage("cmake/Find.cmake"), "cmake");
    assert.equal(detectLanguage("notes.txt"), "other");
  });
});

describe("CMake targets (fixtures/cpp-cmake)", () => {
  it("has golden targets, links, sources and include resolution", async () => {
    const result = await scan("fixtures/cpp-cmake");
    assert.deepEqual(targets(result), [
      "cmake:core static [libs/core/include/core/core.h,libs/core/src/clock.cpp,libs/core/src/core.cpp] -> [] unresolved=0",
      // `${DEMO_EXTRA_LIBS}` is never set: counted, left out. `Threads::Threads` is an external library.
      "cmake:demo executable [app/main.cpp] -> [net] unresolved=1",
      // The glob finds src/net.cpp; the link to core is PUBLIC.
      "cmake:net shared [libs/net/src/net.cpp] -> [core] unresolved=0",
      "cmake:pack executable [tools/pack.cpp] -> [core] unresolved=0",
      "cmake:unpack executable [tools/unpack.cpp] -> [core] unresolved=0",
    ]);
    assert.deepEqual(resolvedIncludes(result), [
      // net's PUBLIC include directory, core's PUBLIC one through the link, and the directory-level config/.
      "app/main.cpp:import:1:net/net.h -> libs/net/include/net/net.h",
      "app/main.cpp:import:2:core/core.h -> libs/core/include/core/core.h",
      // `#include APP_CONFIG_HEADER` with target_compile_definitions(demo PRIVATE APP_CONFIG_HEADER="app/config.h").
      "app/main.cpp:import:3:APP_CONFIG_HEADER -> config/app/config.h",
      "libs/core/src/clock.cpp:import:1:core/core.h -> libs/core/include/core/core.h",
      // A private header next to the source, then core's own PUBLIC directory.
      "libs/core/src/core.cpp:import:1:core/core.h -> libs/core/include/core/core.h",
      "libs/core/src/core.cpp:import:2:detail.hpp -> libs/core/src/detail.hpp",
      "libs/net/include/net/net.h:import:2:core/core.h -> libs/core/include/core/core.h",
      "libs/net/src/net.cpp:import:1:net/net.h -> libs/net/include/net/net.h",
      "libs/net/src/net.cpp:import:2:core/core.h -> libs/core/include/core/core.h",
      "tools/pack.cpp:import:1:core/core.h -> libs/core/include/core/core.h",
      "tools/unpack.cpp:import:1:core/core.h -> libs/core/include/core/core.h",
    ]);
    assert.equal(result.report.unresolvedRelativeImports, 0);
  });

  it("makes an executable target an EntryPoint that RUNS its main", async () => {
    const result = await scan("fixtures/cpp-cmake");
    const entries = result.nodes.filter((node) => node.label === "EntryPoint" && node.properties.library === "cmake").map((node) => `${node.properties.kind}:${node.properties.trigger}@${node.properties.line}`).sort();
    assert.deepEqual(entries, ["cmake-executable:demo@1", "cmake-executable:pack@2", "cmake-executable:unpack@2"]);
    const runs = result.relationships.filter((rel) => rel.type === "RUNS" && rel.from.startsWith("entrypoint:cmake:")).map((rel) => `${rel.from} -> ${strip(rel.to).replace(/:entrypoint:.*/u, "")}`).sort();
    assert.deepEqual(runs, [
      "entrypoint:cmake:app/CMakeLists.txt:demo -> app/main.cpp",
      "entrypoint:cmake:tools/CMakeLists.txt:pack -> tools/pack.cpp",
      "entrypoint:cmake:tools/CMakeLists.txt:unpack -> tools/unpack.cpp",
    ]);
  });
});

describe("Makefile targets (fixtures/cpp-make)", () => {
  it("maps link and archive rules to their sources, through pattern rules and -I flags", async () => {
    const result = await scan("fixtures/cpp-make");
    assert.deepEqual(targets(result), [
      "make:bin/app executable [src/main.c] -> [libtools.a] unresolved=0",
      "make:libtools.a static [src/parser.c,src/util.c] -> [] unresolved=0",
    ]);
    assert.deepEqual(resolvedIncludes(result), [
      "src/main.c:import:1:parser.h -> include/parser.h",
      "src/main.c:import:2:util.h -> include/util.h",
      "src/parser.c:import:1:parser.h -> include/parser.h",
      "src/parser.c:import:2:util.h -> include/util.h",
      "src/util.c:import:1:util.h -> include/util.h",
    ]);
    const runs = result.relationships.filter((rel) => rel.type === "RUNS" && rel.from.startsWith("entrypoint:make:")).map((rel) => `${rel.from} -> ${strip(rel.to).replace(/:entrypoint:.*/u, "")}`);
    assert.deepEqual(runs, ["entrypoint:make:Makefile:bin/app -> src/main.c"]);
  });
});

describe("include paths", () => {
  async function temporary(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "concentrate-cpp-build-"));
  }

  it("moving the include paths of fixtures/cpp-includes into CMake loses no resolved include", async () => {
    const before = resolvedIncludes(await scan("fixtures/cpp-includes"));
    const directory = await temporary();
    try {
      await cp("fixtures/cpp-includes", directory, { recursive: true });
      await rm(path.join(directory, "compile_commands.json"));
      await writeFile(path.join(directory, "CMakeLists.txt"), "add_executable(app src/main.cpp src/config.cpp)\ntarget_include_directories(app PRIVATE include)\ntarget_include_directories(app SYSTEM PRIVATE third_party)\n");
      const after = resolvedIncludes(await scan(directory));
      assert.deepEqual(after, before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads -D of compile_commands.json for a computed include, and merges it with CMake", async () => {
    const directory = await temporary();
    try {
      await mkdir(path.join(directory, "src"), { recursive: true });
      await mkdir(path.join(directory, "gen"), { recursive: true });
      await writeFile(path.join(directory, "src/a.c"), "#include CONFIG_HEADER\n#include <cfg_two.h>\nint main(void) { return 0; }\n");
      await writeFile(path.join(directory, "gen/cfg.h"), "#define X 1\n");
      await writeFile(path.join(directory, "gen/cfg_two.h"), "#define Y 1\n");
      await writeFile(path.join(directory, "compile_commands.json"), JSON.stringify([{ directory: ".", command: "cc -Igen -DCONFIG_HEADER=\\\"cfg.h\\\" -c src/a.c", file: "src/a.c" }]));
      assert.deepEqual(resolvedIncludes(await scan(directory)), ["src/a.c:import:1:CONFIG_HEADER -> gen/cfg.h", "src/a.c:import:2:cfg_two.h -> gen/cfg_two.h"]);
      // The CMake file adds its own directory for a second target; compile_commands.json keeps its own.
      await mkdir(path.join(directory, "other"), { recursive: true });
      await writeFile(path.join(directory, "other/o.c"), "#include <cfg_two.h>\n");
      await writeFile(path.join(directory, "CMakeLists.txt"), "add_library(o other/o.c)\ntarget_include_directories(o PUBLIC gen)\n");
      assert.deepEqual(resolvedIncludes(await scan(directory)), ["other/o.c:import:1:cfg_two.h -> gen/cfg_two.h", "src/a.c:import:1:CONFIG_HEADER -> gen/cfg.h", "src/a.c:import:2:cfg_two.h -> gen/cfg_two.h"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("CMake functions, macros and conditions", () => {
  async function project(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "concentrate-cmake-"));
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), text);
    }
    return directory;
  }

  it("expands functions and macros (ARGN, parameters, PARENT_SCOPE) and foreach over IN LISTS", async () => {
    const directory = await project({
      "CMakeLists.txt": `function(add_tool name)
  add_executable(\${name} src/\${name}.c \${ARGN})
  target_link_libraries(\${name} PRIVATE base)
endfunction()
macro(add_lib name)
  add_library(\${name} src/\${name}.c)
endmacro()
add_lib(base)
add_tool(one)
add_tool(two src/extra.c)
set(NAMES a b)
foreach(n IN LISTS NAMES)
  add_executable(\${n}_bin src/\${n}.c)
endforeach()
`,
      "src/base.c": "int base(void) { return 1; }\n",
      "src/one.c": "int main(void) { return 0; }\n",
      "src/two.c": "int main(void) { return 0; }\n",
      "src/extra.c": "int extra(void) { return 0; }\n",
      "src/a.c": "int main(void) { return 0; }\n",
      "src/b.c": "int main(void) { return 0; }\n",
    });
    try {
      assert.deepEqual(targets(await scan(directory)), [
        "cmake:a_bin executable [src/a.c] -> [] unresolved=0",
        "cmake:b_bin executable [src/b.c] -> [] unresolved=0",
        "cmake:base library [src/base.c] -> [] unresolved=0",
        "cmake:one executable [src/one.c] -> [base] unresolved=0",
        "cmake:two executable [src/extra.c,src/two.c] -> [base] unresolved=0",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips branches that only a Windows or MSVC build takes, and reads every branch of an unknown condition", async () => {
    const directory = await project({
      "CMakeLists.txt": `add_executable(app main.c)
if(MSVC)
  target_sources(app PRIVATE win.c)
elseif(UNIX AND NOT APPLE)
  target_sources(app PRIVATE linux.c)
else()
  target_sources(app PRIVATE other.c)
endif()
if(WIN32 OR MINGW)
  target_sources(app PRIVATE win2.c)
endif()
if(NOT MSVC)
  target_sources(app PRIVATE posix.c)
endif()
if(SOME_OPTION)
  target_sources(app PRIVATE optional.c)
else()
  target_sources(app PRIVATE fallback.c)
endif()
if("\${CMAKE_C_COMPILER_ID}" STREQUAL "MSVC")
  target_sources(app PRIVATE msvc.c)
endif()
`,
      ...Object.fromEntries(["main", "win", "win2", "linux", "other", "posix", "optional", "fallback", "msvc"].map((name) => [`${name}.c`, `int ${name}_f(void) { return 0; }\n`])),
    });
    try {
      assert.deepEqual(targets(await scan(directory)), [
        // `UNIX AND NOT APPLE` is unknown (APPLE is not decided), so linux.c and the else branch both count.
        "cmake:app executable [fallback.c,linux.c,main.c,optional.c,other.c,posix.c] -> [] unresolved=0",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

