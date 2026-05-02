/**
 * Dependency boundary guardrails.
 *
 * Allowed dependency directions:
 *
 *   src/core/contracts/
 *     → src/graph/model.js          (graph model types)
 *     → src/scanner/report.js       (ScanReport type)
 *     → src/scanner/build-code-graph-types.js
 *     → each other
 *     ✗ src/integrations/           (language/framework integrations)
 *     ✗ src/parsers/languages/      (concrete parser implementations)
 *     ✗ src/graph/kuzu*             (Kuzu-specific modules)
 *     ✗ src/adapters/               (platform adapter layer)
 *
 *   src/integrations/languages/
 *     → src/core/                   (contracts and core types)
 *     → src/parsers/                (parser registry and utilities)
 *     → src/graph/model.js          (graph model types)
 *     ✗ src/integrations/frameworks/ (framework semantics)
 *     ✗ src/commands/              (CLI commands)
 *
 *   src/integrations/frameworks/
 *     → src/core/
 *     → src/integrations/languages/
 *     → src/parsers/
 *     → src/graph/model.js
 *     ✗ src/commands/              (CLI commands)
 *     ✗ src/adapters/              (platform adapter layer)
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

async function checkFiles(
  dir: string,
  forbiddenPatterns: string[],
): Promise<Array<{ file: string; violation: string }>> {
  const violations: Array<{ file: string; violation: string }> = [];
  const files = await collectTsFiles(dir);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const imports = extractImportPaths(source);

    for (const imp of imports) {
      for (const forbidden of forbiddenPatterns) {
        if (imp.includes(forbidden)) {
          violations.push({
            file: path.relative(srcRoot, file),
            violation: `forbidden import "${imp}" matches pattern "${forbidden}"`,
          });
        }
      }
    }
  }

  return violations;
}

describe("Architecture dependency guardrails", () => {
  it("src/core/contracts/ does not import from integrations or concrete impls", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "core/contracts"),
      [
        "/integrations/",
        "/parsers/languages/",
        "/graph/kuzu",
        "/adapters/",
      ],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in core/contracts:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/integrations/languages/ does not import from framework integrations or commands", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "integrations/languages"),
      [
        "/integrations/frameworks/",
        "/commands/",
      ],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in integrations/languages:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });

  it("src/integrations/frameworks/ does not import from commands or adapters", async () => {
    const violations = await checkFiles(
      path.join(srcRoot, "integrations/frameworks"),
      [
        "/commands/",
        "/adapters/",
      ],
    );

    assert.deepEqual(
      violations,
      [],
      `Boundary violations in integrations/frameworks:\n${violations.map((v) => `  ${v.file}: ${v.violation}`).join("\n")}`,
    );
  });
});
