import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { coreIntegrationRegistry } from "../../../composition/default-registry.js";
import type { CoreIntegrationRegistry } from "../../../core/integrations/registry.js";
import { findUnusedExports as findUnused } from "../../../core/queries/unused.js";
import { nodeSourceReader } from "../../fs/source-reader.js";
import { optionalBoolean, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";

const NOTE_BASE = "Candidates only. An export counts as used when another file imports it by name (through barrels too) or calls, passes, extends, implements or injects it. Files imported whole (namespace, dynamic or default imports), package entry points and exports named default are skipped; uses outside the scanned repository, string-based lookups and framework conventions are not seen. usedInFile: the export is only used inside its own file. deadFunctions are unexported file-level functions with no calls and no other mention of their name in the file.";

// "A, B and C." over the languages some registered rule judges, in the order their descriptors were registered; languages without a descriptor follow by id.
function languagesNote(registry: CoreIntegrationRegistry): string {
  const judged = new Set(registry.unusedExportRules.flatMap((rules) => rules.languages));
  const described = registry.languages.filter((descriptor) => judged.has(descriptor.id));
  const known = new Set(described.map((descriptor) => descriptor.id));
  const names = [...described.map((descriptor) => descriptor.displayName ?? descriptor.id), ...[...judged].filter((id) => !known.has(id))];
  if (names.length < 2) return `${names.join("")}.`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`;
}

// The generic caveats, each language's own paragraph, then the languages covered.
export function unusedNote(registry: CoreIntegrationRegistry): string {
  return [NOTE_BASE, ...registry.unusedExportRules.flatMap((rules) => rules.note ?? []), languagesNote(registry)].join(" ");
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
    note: unusedNote(registry),
  };
}
