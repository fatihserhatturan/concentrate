import path from "node:path";
import type { ISourceReader } from "../../../core/contracts/source-reader.js";
import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import { isJsTsFile } from "../file-kind.js";

// JavaScript and TypeScript: an export is used when another file imports it
// by name or reaches it through an edge, or when its package exposes it.
export const jsTsUnusedRules: IUnusedExportRules = {
  id: "js-ts",
  languages: ["typescript", "javascript"],
  supports: isJsTsFile,
  packageEntries,
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Scan-relative files that are package entry points: the package.json
// fields main, module, types, browser, bin and exports, mapped back from
// build output to sources where the path does not exist, plus index and
// src/index files at the package root.
async function packageEntries(reader: ISourceReader, packages: readonly { path?: unknown; relativePath?: unknown }[], files: ReadonlyMap<string, unknown>): Promise<string[]> {
  const entries = new Set<string>();
  for (const row of packages) {
    if (typeof row.path !== "string") continue;
    const base = typeof row.relativePath === "string" && row.relativePath !== "." ? row.relativePath : "";
    const targets = ["index", "src/index"];
    try {
      const manifest = JSON.parse((await reader.readFile(path.join(row.path, "package.json"))) ?? "") as Record<string, unknown>;
      for (const field of ["main", "module", "types", "typings", "browser", "bin", "exports"]) collectStrings(manifest[field], targets);
    } catch {
      // No readable manifest: the index fallbacks still apply.
    }
    for (const target of targets) {
      const resolved = resolveEntry(path.posix.join(base, target.replace(/^\.\//, "")), files);
      if (resolved) entries.add(resolved);
    }
  }
  return [...entries];
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, into);
}

function resolveEntry(target: string, files: ReadonlyMap<string, unknown>): string | null {
  const stem = target.replace(/\.d\.(?:m|c)?ts$/, "").replace(/\.(?:[mc]?[jt]sx?)$/, "");
  const stems = [stem, stem.replace(/(^|\/)(?:dist|lib|build|out|esm|cjs)\//, "$1src/")];
  for (const candidate of [target, ...stems.flatMap((item) => [...SOURCE_EXTENSIONS.map((extension) => item + extension), ...SOURCE_EXTENSIONS.map((extension) => `${item}/index${extension}`)])]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}
