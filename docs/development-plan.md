# Development Plan

The current goal is to turn Concentrate from a working scanner demo into a reliable multi-language code graph indexer.

## Milestone 2: Reliable JS/TS Indexer

1. [x] Add directory graph support.
   - Add `Directory` nodes.
   - Represent containment as `Repo -> Directory`, `Directory -> Directory`, and `Directory -> File`.
   - Keep stable directory IDs based on project-relative paths.

2. [x] Add scan reporting and error tolerance.
   - Track discovered files, supported files, skipped files, parsed files, and failed files.
   - Add `--continue-on-error`.
   - Print a concise summary at the end of every scan.

3. [x] Add import resolution.
   - Keep existing `File -> Import` extraction.
   - Resolve relative imports to real source files when possible.
   - Add `Import -> RESOLVES_TO -> File`.

4. [x] Improve call graph modeling.
   - Keep raw call expression nodes.
   - Prepare the model for future `Call -> RESOLVES_TO -> Function` relationships.
   - Avoid claiming semantic resolution until it exists.

5. [x] Add JSONL export.
   - Export `nodes.jsonl`.
   - Export `relationships.jsonl`.
   - Use the export format as a debug and migration path.

6. [x] Add fixture-based tests.
   - Add small JS/TS fixture projects.
   - Assert graph counts and selected relationships.
   - Cover imports, classes, functions, and call expressions.

## Milestone 3: Multi-Language Indexing

7. [x] Add Python parser support.
   - Detect `.py` files.
   - Extract Python imports, functions, classes, and calls.
   - Resolve simple relative imports such as `from .utils import utility`.
   - Cover the behavior with fixture tests.

8. [x] Formalize language parser registry.
   - Introduce a `LanguageParser` interface.
   - Register JS/TS and Python parsers through a common registry.
   - Keep `parseSourceFile` as a thin registry lookup.
   - Make adding Go/Rust a small adapter task.

9. [x] Harden Python import resolution.
   - Resolve `from package.module import x`.
   - Resolve `from . import utils`.
   - Resolve `from ..core import thing`.
   - Handle `import package.module as alias`.
   - Account for `__init__.py` package files.
   - Add fixture tests for each case.

10. [x] Add JS/TS path and package resolution.
   - Read `tsconfig.json` `baseUrl` and `paths`.
   - Resolve aliases such as `@/utils/foo`.
   - [ ] Read `package.json` `exports`, `main`, and `types` where useful.
   - Add fixtures for path aliases and package-style imports.

11. [x] Add Go parser support.
   - Detect `.go` files.
   - Extract package declarations, imports, functions, methods, and structs.
   - Extract basic call expressions.
   - Add Go fixture tests.

12. [x] Add Rust parser support.
   - Detect `.rs` files.
   - Extract `use`, `mod`, `fn`, `struct`, and `impl` structures.
   - Extract basic call expressions.
   - Add Rust fixture tests.

13. [ ] Add scan progress and parser concurrency.
   - Parse files with bounded concurrency.
   - Add progress output for large repositories.
   - Add `--max-files`, `--include`, and `--exclude` options.
   - Keep output deterministic despite concurrency.

14. [ ] Add schema version marker.
   - Add a schema/version metadata table or node.
   - Record graph schema version during scan/export.
   - Prepare for future migrations instead of reset-only behavior.

## Milestone 4: Project Structure

8. [x] Refactor scanner and CLI structure.
   - Move graph mutation and dedupe logic into `GraphBuilder`.
   - Move directory graph creation and import resolution into focused scanner modules.
   - Move CLI scan reporting into a shared presenter.
   - Share Tree-sitter traversal helpers between language parsers.

## Current Priority

Rust parser support is complete. Package `exports`/`main`/`types` remains as a future follow-up for JS/TS. Next recommended task: add scan progress and parser concurrency.
