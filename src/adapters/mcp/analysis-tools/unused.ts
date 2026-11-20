import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { coreIntegrationRegistry } from "../../../composition/default-registry.js";
import type { CoreIntegrationRegistry } from "../../../core/integrations/registry.js";
import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import { findUnusedExports as findUnused } from "../../../core/queries/unused.js";
import { nodeSourceReader } from "../../fs/source-reader.js";
import { optionalBoolean, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";

const NOTE_BASE = "Candidates only. An export counts as used when another file imports it by name (through barrels too) or calls, passes, extends, implements or injects it. Files imported whole (namespace, dynamic or default imports), package entry points and exports named default are skipped; uses outside the scanned repository, string-based lookups and framework conventions are not seen. usedInFile: the export is only used inside its own file. deadFunctions are unexported file-level functions with no calls and no other mention of their name in the file.";

// Display names and listing order of the languages the tool ships; others follow by id, in registration order.
const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ["javascript", "JavaScript"], ["typescript", "TypeScript"], ["python", "Python"], ["go", "Go"], ["rust", "Rust"], ["c", "C"], ["cpp", "C++"],
]);

// "A, B and C." over every language a registered rule judges.
function languagesNote(rules: readonly IUnusedExportRules[]): string {
  const ids = [...new Set(rules.flatMap((entry) => entry.languages))];
  const known = [...LANGUAGE_NAMES.keys()].filter((id) => ids.includes(id));
  const names = [...known, ...ids.filter((id) => !LANGUAGE_NAMES.has(id))].map((id) => LANGUAGE_NAMES.get(id) ?? id);
  if (names.length < 2) return `${names.join("")}.`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`;
}

// The generic caveats, each language's own paragraph, then the languages covered.
export function unusedNote(rules: readonly IUnusedExportRules[]): string {
  return [NOTE_BASE, ...rules.flatMap((entry) => entry.note ?? []), languagesNote(rules)].join(" ");
}

// find_unused_exports: core analysis, paged.
export async function findUnusedExports(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow, registry: CoreIntegrationRegistry = coreIntegrationRegistry) {
  const rules = registry.unusedExportRules;
  const file = optionalString(args.file);
  const includeTests = optionalBoolean(args.includeTests) ?? false;
  const result = await findUnused(engine, nodeSourceReader, { file, includeTests, rules });

  const unused = result.unusedExports.map(({ id: _id, usedInFile, ...entry }) => ({ ...entry, ...(usedInFile ? { usedInFile: true } : {}) }));
  return {
    query: result.query,
    total: unused.length,
    unusedExports: window.take(unused),
    deadFunctions: result.deadFunctions.map(({ id: _id, ...entry }) => entry),
    skipped: result.skipped,
    note: unusedNote(rules),
  };
}
