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
  const pattern = /^(?:import|export)\s[^'"]*['"]([^'"]+)['"]/gm;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    paths.push(match[1]);
  }
  return pattern[Symbol.replace] !== undefined ? paths : paths;
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
    const imports = extractImportPaths(source);

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

  it("src/core/ does not depend on platform adapters, command modules, or legacy directories", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "core"),
      [
        "adapters/cli/",
        "adapters/kuzu/",
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
});
