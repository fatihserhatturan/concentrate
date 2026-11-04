import { objectSchema } from "../args.js";
import type { McpTool } from "../tools.js";
import { architectureOverview } from "./architecture.js";
import { findImportCycles } from "./cycles.js";
import { findReferences } from "./references.js";
import { DECLARATION_KINDS, searchSymbols } from "./search.js";
import { findUnusedExports } from "./unused.js";

// Search, navigation and whole-repository analysis over the graph. Like the
// agent tools, each pages one primary list.

const limit = (fallback: number) => ({ type: "number", description: `Page size. Defaults to ${fallback}, at most 200.` });
const kind = { type: "string", description: `${DECLARATION_KINDS.join(", ")}.` };

export const analysisToolDefinitions = [
  {
    name: "search_symbols",
    description: "Fuzzy search over declarations. Ranks exact names, then prefixes, word initials (gUS finds getUserService), substrings and letters in order (injctr finds Injector), each with its match type and score. A query with a dot matches Class.method.",
    inputSchema: objectSchema({
      query: { type: "string", description: "Name or fragment." },
      kind,
      file: { type: "string", description: "File or directory path (scan-relative), or a path suffix." },
      limit: limit(20),
    }, ["query"]),
  },
  {
    name: "find_references",
    description: "Where a declaration is used, each with kind, file and line: calls and callbacks, imports and re-exports (through barrels; namespace and dynamic imports marked possible), subclasses, implementations, injection sites, and the routes and entrypoints a function handles.",
    inputSchema: objectSchema({
      symbol: { type: "string", description: "Exact declaration name; Class.method selects one class's method." },
      file: { type: "string", description: "File or directory path, or a path suffix, of the declaration." },
      kind,
      limit: limit(50),
    }, ["symbol"]),
  },
  {
    name: "find_import_cycles",
    description: "Import cycles: groups of files (or workspace packages) that import each other, largest first, each with one shortest example cycle; cycles only through type-only imports are marked typeOnly.",
    inputSchema: objectSchema({
      scope: { type: "string", description: "file (default) or package." },
      path: { type: "string", description: "File, directory or path suffix (a package name with scope package); keeps only cycles through it and lists just its members." },
      limit: limit(20),
    }),
  },
  {
    name: "find_unused_exports",
    description: "Candidate dead code in JavaScript and TypeScript: exports no other file imports by name or calls, and unexported file-level functions nothing calls or mentions. Package entry points, files imported whole (namespace, dynamic, default), route and entrypoint handlers and tests are skipped (counted under skipped).",
    inputSchema: objectSchema({
      file: { type: "string", description: "File or directory path, or a path suffix, to check." },
      includeTests: { type: "boolean", description: "Also check test and fixture files. Defaults to false." },
      limit: limit(50),
    }),
  },
  {
    name: "architecture_overview",
    description: "Repository structure: groups (workspace packages, or directories at a depth) with file, language, function, class, route, entrypoint and data model counts, and the import edges between groups, heaviest first.",
    inputSchema: objectSchema({
      level: { type: "string", description: "package (default) or directory." },
      depth: { type: "number", description: "For level directory: path segments per group, 1 to 6. Defaults to 2." },
      limit: limit(50),
    }),
  },
];

export const analysisTools: Record<string, McpTool> = {
  search_symbols: { handler: searchSymbols, listKey: "symbols", defaultLimit: 20 },
  find_references: { handler: findReferences, listKey: "references", defaultLimit: 50 },
  find_import_cycles: { handler: findImportCycles, listKey: "cycles", defaultLimit: 20 },
  find_unused_exports: { handler: findUnusedExports, listKey: "unusedExports", defaultLimit: 50 },
  architecture_overview: { handler: architectureOverview, listKey: "edges", defaultLimit: 50 },
};
