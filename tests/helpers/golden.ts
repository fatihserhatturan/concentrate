import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildCodeGraph } from "../../src/composition/orchestrator.js";
import { formatNormalizedGraph, normalizeGraph, ROOT_PLACEHOLDER } from "../../src/core/graph/normalize.js";
import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "../../src/core/scan/result.js";

export const goldenRoot = path.join(import.meta.dirname, "../golden");
export const updateGolden = process.env.UPDATE_GOLDEN === "1";

const MAX_DIFF_LINES = 50;

/** A fixture directory holding nothing but a README.md is a pending placeholder (Phase 46/47 wave 0): no golden until it has sources. */
export const isPlaceholderFixture = (directory: string): boolean => !readdirSync(directory).some((file) => file !== "README.md");

/** Scan a project and render it as golden text: one report line, then the normalized graph. */
export async function scanToGoldenText(
  projectPath: string,
  options: Partial<BuildCodeGraphOptions> = {},
): Promise<string> {
  const result = await buildCodeGraph(projectPath, { continueOnError: true, concurrency: 4, ...options });
  return renderGolden(result);
}

export function renderGolden(result: BuildCodeGraphResult): string {
  const replaceRoot = (value: string) => value.replaceAll(result.rootPath, ROOT_PLACEHOLDER);
  const entries = (items: Array<{ path: string; message: string }>) => items
    .map((item) => ({ path: replaceRoot(item.path), message: replaceRoot(item.message) }))
    // Config files are read concurrently, so warning order is not stable.
    .sort((a, b) => `${a.path}\0${a.message}`.localeCompare(`${b.path}\0${b.message}`));
  const report = {
    kind: "report",
    status: result.report.status,
    discoveredFiles: result.report.discoveredFiles,
    supportedFiles: result.report.supportedFiles,
    parsedFiles: result.report.parsedFiles,
    failedFiles: entries(result.report.failedFiles),
    warnings: entries(result.report.warnings),
  };
  return `${JSON.stringify(report)}\n${formatNormalizedGraph(normalizeGraph(result))}`;
}

/**
 * Compare `actual` with the golden file, or rewrite it when UPDATE_GOLDEN=1.
 * Files ending in `.gz` are stored gzip-compressed. `readOnly` goldens are
 * references that UPDATE_GOLDEN=1 must not rewrite.
 */
export async function assertGolden(goldenPath: string, actual: string, options: { readOnly?: boolean } = {}): Promise<void> {
  const compressed = goldenPath.endsWith(".gz");
  if (updateGolden && !options.readOnly) {
    await mkdir(path.dirname(goldenPath), { recursive: true });
    await writeFile(goldenPath, compressed ? gzipSync(actual, { level: 9 }) : actual);
    return;
  }

  let expected: string;
  try {
    const raw = await readFile(goldenPath);
    expected = compressed ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      assert.fail(`Missing golden file ${path.relative(process.cwd(), goldenPath)}. Run \`npm run golden:update\` to create it.`);
    }
    throw error;
  }

  if (expected !== actual) {
    assert.fail(`Golden mismatch for ${path.relative(process.cwd(), goldenPath)}\n${lineDiff(expected, actual)}\n`
      + "If this change is intended, run `npm run golden:update` and explain the diff in the PR.");
  }
}

/** Order-insensitive line diff; golden records are sorted, so a changed record shows as a -/+ pair. */
export function lineDiff(expected: string, actual: string): string {
  const counts = new Map<string, number>();
  for (const line of expected.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of actual.split("\n")) {
    const count = counts.get(line) ?? 0;
    if (count > 0) counts.set(line, count - 1);
    else added.push(line);
  }
  const removed = [...counts].flatMap(([line, count]) => Array<string>(count).fill(line));
  const lines = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)];
  const shown = lines.slice(0, MAX_DIFF_LINES).join("\n");
  const summary = `${removed.length} removed, ${added.length} added`;
  return lines.length > MAX_DIFF_LINES
    ? `${summary} (showing first ${MAX_DIFF_LINES}):\n${shown}`
    : `${summary}:\n${shown}`;
}
