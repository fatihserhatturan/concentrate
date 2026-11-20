import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { defaultUnusedExportRules } from "../../../composition/unused-rules.js";
import { findUnusedExports as findUnused } from "../../../core/queries/unused.js";
import { nodeSourceReader } from "../../fs/source-reader.js";
import { optionalBoolean, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";

const NOTE_BASE = "Candidates only. An export counts as used when another file imports it by name (through barrels too) or calls, passes, extends, implements or injects it. Files imported whole (namespace, dynamic or default imports), package entry points and exports named default are skipped; uses outside the scanned repository, string-based lookups and framework conventions are not seen. usedInFile: the export is only used inside its own file. deadFunctions are unexported file-level functions with no calls and no other mention of their name in the file.";
const NOTE_LANGUAGES = "JavaScript, TypeScript, Python, Go, Rust, C and C++.";

// The generic caveats, each language's own paragraph, then the languages covered.
function unusedNote(): string {
  return [NOTE_BASE, ...defaultUnusedExportRules.flatMap((rules) => rules.note ?? []), NOTE_LANGUAGES].join(" ");
}

// find_unused_exports: core analysis, paged.
export async function findUnusedExports(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const file = optionalString(args.file);
  const includeTests = optionalBoolean(args.includeTests) ?? false;
  const result = await findUnused(engine, nodeSourceReader, { file, includeTests, rules: defaultUnusedExportRules });

  const unused = result.unusedExports.map(({ id: _id, usedInFile, ...entry }) => ({ ...entry, ...(usedInFile ? { usedInFile: true } : {}) }));
  return {
    query: result.query,
    total: unused.length,
    unusedExports: window.take(unused),
    deadFunctions: result.deadFunctions.map(({ id: _id, ...entry }) => entry),
    skipped: result.skipped,
  note: unusedNote(),
  };
}
