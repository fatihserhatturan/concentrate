import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { findUnusedExports as findUnused } from "../../../core/queries/unused.js";
import { nodeSourceReader } from "../../fs/source-reader.js";
import { optionalBoolean, optionalString } from "../args.js";
import type { PageWindow } from "../paging.js";

// find_unused_exports: core analysis, paged.
export async function findUnusedExports(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const file = optionalString(args.file);
  const includeTests = optionalBoolean(args.includeTests) ?? false;
  const result = await findUnused(engine, nodeSourceReader, { file, includeTests });

  const unused = result.unusedExports.map(({ id: _id, usedInFile, ...entry }) => ({ ...entry, ...(usedInFile ? { usedInFile: true } : {}) }));
  return {
    query: result.query,
    total: unused.length,
    unusedExports: window.take(unused),
    deadFunctions: result.deadFunctions.map(({ id: _id, ...entry }) => entry),
    skipped: result.skipped,
note: "Candidates only. An export counts as used when another file imports it by name (through barrels too) or calls, passes, extends, implements or injects it. Files imported whole (namespace, dynamic or default imports), package entry points and exports named default are skipped; uses outside the scanned repository, string-based lookups and framework conventions are not seen. usedInFile: the export is only used inside its own file. deadFunctions are unexported file-level functions with no calls and no other mention of their name in the file. Go: an export (capitalized name) counts as used when another package calls it or mentions its name; main packages and init are skipped, and deadFunctions look for mentions in the whole package. Rust: only `pub` items count; one counts as used when another crate calls it or mentions its name; binary crates (main.rs, src/bin, examples, tests, benches) are skipped, and library items consumed outside the repository are not seen. Python: module-level names that are not private (or are listed in `__all__`); `from m import *` marks the whole module as used, and `__main__.py`, `setup.py`, `manage.py`, `wsgi.py`, `asgi.py` and `conftest.py` are skipped. C and C++: a non-static function, class, struct or enum counts as used when a call from another unit (foo.h with foo.cpp is one unit) reaches its definition or another unit mentions its name (for a function, in a source file: a prototype in a header is no use); static and anonymous-namespace functions are checked as deadFunctions only; macros and prototypes are not judged, and uses through function pointers, macros or code outside the repository are not seen. JavaScript, TypeScript, Python, Go, Rust, C and C++.",
  };
}
