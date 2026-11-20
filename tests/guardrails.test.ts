/**
 * Dependency boundary guardrails.
 *
 * Allowed dependency directions:
 *
 *   src/core/contracts/
 *     → src/core/graph/model.js     (graph model DTO exports)
 *     → src/core/scan/              (scan/report/result DTO exports)
 *     → each other
 *     ✗ src/integrations/           (language/framework integrations)
 *     ✗ src/adapters/               (platform adapter layer)
 *     ✗ src/commands/               (CLI commands)
 *     ✗ scanner/, parsers/, graph/  (legacy directories, now deleted)
 *
 *   src/core/scan/ and src/core/graph/
 *     → src/core/graph/             (graph model)
 *     → src/core/scan/              (scan utilities)
 *     → src/core/contracts/         (interfaces)
 *     → src/core/integrations/      (registry wiring)
 *     ✗ src/integrations/           (language/framework integrations)
 *     ✗ src/adapters/               (platform adapter layer)
 *
 *   src/core/ (all subdirectories)
 *     ✗ src/composition/            (default wiring; depends on integrations)
 *     ✗ src/integrations/
 *
 *   src/integrations/languages/
 *     → src/core/                   (contracts and core types)
 *     → each other (cross-language)
 *     ✗ src/integrations/frameworks/ (framework semantics)
 *     ✗ src/adapters/               (platform adapter layer)
 *     ✗ src/commands/               (CLI commands)
 *     ✗ scanner/, parsers/, graph/  (legacy directories, now deleted)
 *
 *   src/integrations/frameworks/
 *     → src/core/
 *     → src/integrations/languages/
 *     ✗ src/adapters/               (platform adapter layer)
 *     ✗ src/commands/               (CLI commands)
 *     ✗ scanner/, parsers/, graph/  (legacy directories, now deleted)
 *
 *   src/commands/
 *     → src/adapters/cli/           (platform command adapters)
 *     ✗ src/core/, src/integrations/, src/parsers/
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const srcRoot = path.join(import.meta.dirname, "../src");

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.join(e.parentPath, e.name));
}

function extractImportPaths(source: string): string[] {
  // Static `import ... from "x"`, `export ... from "x"` and side-effect `import "x"`.
  // The specifier must follow `from` or the keyword directly, so string literals
  // inside ordinary `export const` / `export function` declarations are ignored.
  const pattern = /^\s*(?:import|export)\b(?:[^'";]*?\bfrom)?\s*['"]([^'"\n]+)['"]/gm;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

/** Source with comments removed, so example code in comments is not read as an import. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Dynamic `import("x")` and `require("x")` specifiers outside comments. */
function extractDynamicImportPaths(source: string): string[] {
  return [...codeOnly(source).matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!);
}

/** Every module specifier a file imports, static and dynamic. */
function extractAllImportPaths(source: string): string[] {
  return [...extractImportPaths(source), ...extractDynamicImportPaths(source)];
}

function resolveImportPath(file: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) {
    return null;
  }

  const resolved = path.resolve(path.dirname(file), importPath);
  return path.relative(srcRoot, resolved).split(path.sep).join("/");
}

async function checkFiles(
  dir: string,
  forbiddenPrefixes: string[],
): Promise<Array<{ file: string; violation: string }>> {
  const violations: Array<{ file: string; violation: string }> = [];
  const files = await collectTsFiles(dir);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const imports = extractAllImportPaths(source);

    for (const imp of imports) {
      const resolved = resolveImportPath(file, imp);
      if (!resolved) {
        continue;
      }

      for (const forbidden of forbiddenPrefixes) {
        if (resolved === forbidden || resolved.startsWith(forbidden)) {
          violations.push({
            file: path.relative(srcRoot, file),
            violation: `forbidden import "${imp}" resolves to "${resolved}" under "${forbidden}"`,
          });
        }
      }
    }
  }

  return violations;
}

const legacyDirs = ["scanner/", "parsers/", "graph/"];

/**
 * Runtime packages src/ may import (docs/ROADMAP.md). The only one is
 * web-tree-sitter: plain JS and WebAssembly, pinned, with no dependencies and
 * no install scripts. Grammars are vendored WebAssembly, not packages.
 */
const RUNTIME_DEPENDENCY_ALLOWLIST: readonly string[] = [
  "web-tree-sitter",
];

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Bare (non-relative, non-`node:`) package imports per src/ file, including dynamic import() and require(). */
async function bareImportsBySourceFile(): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  for (const file of await collectTsFiles(srcRoot)) {
    const source = await readFile(file, "utf8");
    const specifiers = extractAllImportPaths(source);
    const packages = new Set(specifiers
      .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"))
      .map(packageNameOf));
    if (packages.size > 0) {
      result.set(path.relative(srcRoot, file), packages);
    }
  }
  return result;
}

function relativeToSrc(file: string): string {
  return path.relative(srcRoot, file).split(path.sep).join("/");
}

/**
 * A shrinking allow-list: `found` must not contain anything outside `allowed`
 * (no new debt), and every `allowed` entry must still be found (remove it once
 * fixed, so the list only ever gets shorter).
 */
function assertRatchet(found: Iterable<string>, allowed: readonly string[], what: string): void {
  const foundSet = new Set(found);
  const added = [...foundSet].filter((entry) => !allowed.includes(entry)).sort();
  const stale = allowed.filter((entry) => !foundSet.has(entry));
  assert.deepEqual(added, [], `New ${what} (move it behind a contract instead):\n  ${added.join("\n  ")}`);
  assert.deepEqual(stale, [], `Fixed ${what}; remove from the allow-list:\n  ${stale.join("\n  ")}`);
}

/**
 * Node built-ins core may use anywhere. Path arithmetic is pure; file system,
 * hashing, compression and OS access belong behind ports
 * (docs/layered-core-architecture.md, "Core I/O").
 */
const CORE_PURE_BUILTINS: readonly string[] = ["node:path"];

/** Core files that still touch the platform directly (empty: file system, hashing and the parse cache go through ports). */
const CORE_PLATFORM_IO_DEBT: readonly string[] = [];

/**
 * Core files that know a concrete language: named after one, branching on a
 * per-language file predicate, comparing `language` to a language id,
 * testing a language's file extension, or naming an ecosystem's files
 * (`package.json`, `go.mod`, `node_modules`, `conftest`...). Shrinks as resolution moves to
 * src/integrations/languages/<language>/.
 */
const CORE_LANGUAGE_KNOWLEDGE_DEBT: readonly string[] = [
];

const LANGUAGE_FILE_NAME = /^(go|rust|python|cpp|c|java|kotlin|ruby|php|csharp|js|ts|jsts)-/;
const LANGUAGE_PREDICATE = /\bis(Go|Python|Rust|Cpp|C|JsTs|Java)File\b/;
const LANGUAGE_COMPARISON = /(?<!typeof\s+(?:[\w$]+\.)*)\blanguage\s*[!=]==?\s*["'][a-z+#-]+["']/;
const ECOSYSTEM_FILE_NAME = /node_modules|package\.json|package-lock|tsconfig|pnpm-|yarn\.lock|go\.(?:mod|sum)\b|Cargo\.(?:toml|lock)|pyproject|__init__\.py|_test\.go|conftest|CMakeLists/;
const LANGUAGE_EXTENSION_TEST = /\.endsWith\(\s*["']\.(py|go|rs|c|cc|cpp|cxx|h|hh|hpp|java|ts|tsx|js|jsx|mjs|cjs)["']\s*\)/;

/** Adapter modules src/api.ts still re-exports. Shrinks as use cases move into core. */
const API_ADAPTER_EXPORT_DEBT: readonly string[] = [
  "adapters/store/schema.js",
];

describe("Core purity ratchets", () => {
  it("src/core/ uses only pure node: built-ins outside the platform I/O allow-list", async () => {
    const offenders: string[] = [];
    for (const file of await collectTsFiles(path.join(srcRoot, "core"))) {
      const builtins = extractAllImportPaths(await readFile(file, "utf8"))
        .filter((specifier) => specifier.startsWith("node:") && !CORE_PURE_BUILTINS.includes(specifier));
      if (builtins.length > 0) offenders.push(relativeToSrc(file));
    }
    assertRatchet(offenders, CORE_PLATFORM_IO_DEBT, "platform I/O (node:fs, os, crypto, zlib...) in core");
  });

  it("src/core/ does not gain language-specific code", async () => {
    const offenders: string[] = [];
    for (const file of await collectTsFiles(path.join(srcRoot, "core"))) {
      const code = codeOnly(await readFile(file, "utf8"));
      if (
        LANGUAGE_FILE_NAME.test(path.basename(file))
        || LANGUAGE_PREDICATE.test(code)
        || LANGUAGE_COMPARISON.test(code)
        || LANGUAGE_EXTENSION_TEST.test(code)
        || ECOSYSTEM_FILE_NAME.test(code)
      ) {
        offenders.push(relativeToSrc(file));
      }
    }
    assertRatchet(offenders, CORE_LANGUAGE_KNOWLEDGE_DEBT, "language-specific code in core");
  });

  it("src/api.ts does not gain re-exports from adapters", async () => {
    const apiFile = path.join(srcRoot, "api.ts");
    const adapterModules = extractAllImportPaths(await readFile(apiFile, "utf8"))
      .map((specifier) => resolveImportPath(apiFile, specifier))
      .filter((resolved): resolved is string => resolved?.startsWith("adapters/") ?? false);
    assertRatchet(adapterModules, API_ADAPTER_EXPORT_DEBT, "adapter re-exports in the public API");
  });
});

describe("Architecture dependency guardrails", () => {
  it("src/core/contracts/ only imports core contracts, core graph, and core scan DTOs", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "core/contracts"),
      [
        "integrations/",
        "adapters/",
        "commands/",
        ...legacyDirs,
      ],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in core/contracts:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/core/scan/ and src/core/graph/ do not import from integrations or adapters", async () => {
    const violations = [
      ...await checkFiles(path.join(srcRoot, "core/scan"), ["integrations/", "adapters/", ...legacyDirs]),
      ...await checkFiles(path.join(srcRoot, "core/graph"), ["integrations/", "adapters/", ...legacyDirs]),
    ];

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in core/scan or core/graph:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/core/ does not depend on composition, integrations, platform adapters, command modules, or legacy directories", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "core"),
      [
        "composition/",
        "integrations/",
        "adapters/cli/",
        "adapters/store/",
        "adapters/mcp/",
        "commands/",
        ...legacyDirs,
      ],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in core:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/integrations/languages/ does not import from framework integrations, adapters, commands, or legacy directories", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "integrations/languages"),
      [
        "integrations/frameworks/",
        "adapters/",
        "commands/",
        ...legacyDirs,
      ],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in integrations/languages:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/integrations/languages/ does not mention framework or library names (they belong in frameworks/)", async () => {
    const frameworkName =
      /\b(express|koa|fastify|nestjs|nest|hapi|socket\.io|bullmq|bull|node-cron|node-schedule|prisma|typeorm|sequelize|knex|mongoose)\b/gi;
    const violations: string[] = [];
    for (const file of await collectTsFiles(path.join(srcRoot, "integrations/languages"))) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        const names = line.match(frameworkName);
        if (names) violations.push(`${path.relative(srcRoot, file)}:${index + 1}: ${names.join(", ")}`);
      });
    }

    assert.deepEqual(violations, [], `Framework names in integrations/languages:\n  ${violations.join("\n  ")}`);
  });

  it("src/integrations/frameworks/ does not import from adapters, commands, or legacy directories", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "integrations/frameworks"),
      [
        "adapters/",
        "commands/",
        ...legacyDirs,
      ],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in integrations/frameworks:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/integrations/languages/js-ts/resolution/ does not import from framework integrations", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "integrations/languages/js-ts/resolution"),
      ["integrations/frameworks/"],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in js-ts/resolution:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/integrations/frameworks/js-ts/resolution/ does not import from adapters or commands", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "integrations/frameworks/js-ts/resolution"),
      ["adapters/", "commands/"],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in frameworks/js-ts/resolution:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/commands/ delegates to CLI adapters instead of core, integrations, or legacy directories", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "commands"),
      [
        "core/",
        "integrations/",
        "parsers/",
        ...legacyDirs,
      ],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in commands:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/ imports only node: built-ins and allow-listed runtime dependencies", async () => {
    const violations: string[] = [];
    for (const [file, packages] of await bareImportsBySourceFile()) {
      for (const name of packages) {
        if (!RUNTIME_DEPENDENCY_ALLOWLIST.includes(name)) {
          violations.push(`${file}: imports "${name}"`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `New runtime dependencies are not allowed (zero-dependency goal, docs/ROADMAP.md):\n${violations.join("\n")}`,
    );
  });

  it("package.json dependencies are a subset of the runtime allow-list", async () => {
    const packageJson = JSON.parse(await readFile(path.join(srcRoot, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const extra = Object.keys(packageJson.dependencies ?? {}).filter((name) => !RUNTIME_DEPENDENCY_ALLOWLIST.includes(name));

    assert.deepEqual(extra, [], `Dependencies outside the allow-list: ${extra.join(", ")}`);
  });

  it("every allow-listed runtime dependency is still imported (remove it from the list once unused)", async () => {
    const used = new Set([...(await bareImportsBySourceFile()).values()].flatMap((packages) => [...packages]));
    const stale = RUNTIME_DEPENDENCY_ALLOWLIST.filter((name) => !used.has(name));

    assert.deepEqual(stale, [], `Allow-listed but no longer imported; remove from RUNTIME_DEPENDENCY_ALLOWLIST and package.json: ${stale.join(", ")}`);
  });

  it("runtime dependencies are pinned and install without scripts or dependencies of their own", async () => {
    const packageJson = JSON.parse(await readFile(path.join(srcRoot, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const problems: string[] = [];
    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`${name}: ${version} is not an exact version`);
      const installed = JSON.parse(await readFile(path.join(srcRoot, "../node_modules", name, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      for (const hook of ["preinstall", "install", "postinstall"]) {
        if (installed.scripts?.[hook]) problems.push(`${name}: has a ${hook} script`);
      }
      if (Object.keys(installed.dependencies ?? {}).length > 0) problems.push(`${name}: has dependencies`);
    }

    assert.deepEqual(problems, []);
  });

  it("only the syntax module imports web-tree-sitter", async () => {
    const importers = [...(await bareImportsBySourceFile())]
      .filter(([, packages]) => packages.has("web-tree-sitter"))
      .map(([file]) => file);

    assert.deepEqual(importers, [path.normalize("integrations/languages/syntax/tree-sitter.ts")]);
  });

  it("CLI adapters use graph queries from core, not from the MCP adapter (only `concentrate mcp` starts the server)", async () => {
    const violations = (await checkFiles(path.join(srcRoot, "adapters/cli"), ["adapters/mcp/"]))
      .filter((v) => v.file !== path.normalize("adapters/cli/mcp.ts"));

    assert.deepEqual(
      violations,
      [],
      `CLI reaches into the MCP adapter:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("CLI and MCP adapters reach the graph store only through contracts and composition", async () => {
    const violations = [
      ...await checkFiles(path.join(srcRoot, "adapters/cli"), ["adapters/store/"]),
      ...await checkFiles(path.join(srcRoot, "adapters/mcp"), ["adapters/store/"]),
    ];

    assert.deepEqual(
      violations,
      [],
      `Storage engine leaks into CLI/MCP:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });
});
