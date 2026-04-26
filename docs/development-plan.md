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

13. [x] Add scan progress and parser concurrency.
   - Parse files with bounded concurrency.
   - Add progress output for large repositories.
   - Add `--max-files`, `--include`, and `--exclude` options.
   - Keep output deterministic despite concurrency.

14. [x] Add schema version marker.
   - Add a schema/version metadata table or node.
   - Record graph schema version during scan/export.
   - Prepare for future migrations instead of reset-only behavior.

## Milestone 4: Graph Completeness

The goal of this milestone is to close the most significant gaps in graph accuracy so that
the tool produces a faithful structural model of real-world codebases.

### 4a — JS/TS parser completeness

15. [x] Extract arrow functions and function expressions in JS/TS.
   - Extract `const foo = () => {}` (arrow_function assigned to variable).
   - Extract `const foo = async () => {}`.
   - Extract `export const foo = () => {}` (exported arrow).
   - Extract `const foo = function() {}` (function expression).
   - Use the variable name as the function name when available.
   - Add fixture tests for each form.

16. [x] Add per-language dedicated parser instances.
   - Create one `new Parser()` per language, language pre-set at module init.
   - Remove all `setLanguage()` calls from the parse hot path.
   - Prevents fragility if an `await` is ever introduced between language switch and parse.

### 4b — Graph model accuracy

17. [x] Attribute class methods to their class, not their file.
   - Add `DEFINES_METHOD` relationship: `Class → Function`.
   - Remove the `File → DEFINES_FUNCTION` edge for methods that belong to a class.
   - Apply to all languages: JS/TS `method_definition`, Python class body
     `function_definition`, Go `method_declaration`, Rust `impl` methods.
   - Add `className` property to Function nodes for quick lookup.
   - Update fixture tests to assert the new relationship.

18. [x] Add function and class metadata properties.
   - `isExported: boolean` on Function and Class nodes (JS/TS `export` keyword,
     Python leading `_` convention, Go uppercase name, Rust `pub`).
   - `isAsync: boolean` on Function nodes (JS/TS `async`, Python `async def`,
     Rust `async fn`).
   - Enables queries such as "list all exported async functions".
   - Add fixture assertions for each property.

### 4c — Test coverage

19. [x] Add per-parser unit test files.
   - One test file per language: `javascript.test.ts`, `typescript.test.ts`,
     `python.test.ts`, `go.test.ts`, `rust.test.ts`.
   - Each test asserts extracted node counts, node properties (`name`, `kind`,
     `isExported`, `isAsync`), and key relationships.
   - Cover the arrow function forms added in task 15 and method attribution from task 17.
   - These tests should have caught the arrow-function gap before it shipped.

### 4d — Query and output ergonomics

20. [x] Add `--format` option to the `query` command.
   - `--format json` (default, current behavior): pretty-printed JSON array.
   - `--format table`: ASCII table via `console.table`.
   - `--format csv`: header row + comma-separated values, suitable for piping.
   - Keep the default as `json` for scriptability.

### 4e — Import resolution completeness

21. [x] Add Go project-internal import resolution.
   - Detect the module name from `go.mod`.
   - Resolve `module/pkg/foo` imports to local `.go` files.
   - Add `RESOLVES_TO` edges for internal packages.
   - Add fixture and test.

22. [x] Add Rust crate-relative import resolution.
   - Resolve `use crate::module` and `use super::module` to local `.rs` files.
   - Add `RESOLVES_TO` edges for crate-internal paths.
   - Add fixture and test.

## Milestone 5: Graph Depth and Queryability

The goal of this milestone is to make the graph genuinely useful for code intelligence queries
by closing the most critical structural and semantic gaps.

### 5a — Call resolution

23. [x] Resolve call expressions to their target Function nodes.
   - Add `RESOLVES_TO` relationship: `Call → Function`.
   - For same-file calls: match by function name within the same file.
   - For cross-file calls: use import graph to locate the defining file, then match by name.
   - Apply to all languages.
   - Enables queries such as "list all callers of function X".

### 5b — TypeScript-specific constructs

24. [ ] Extract TypeScript interfaces, type aliases, and enums.
   - Add `Interface` node label for `interface` declarations.
   - Add `TypeAlias` node label for `type X = ...` declarations.
   - Add `Enum` node label for `enum` declarations.
   - Add `DEFINES_INTERFACE`, `DEFINES_TYPE_ALIAS`, `DEFINES_ENUM` relationships from File.
   - Extract `isExported` on each.
   - Add fixture and tests.

### 5c — Inheritance and implementation relationships

25. [ ] Extract class inheritance and interface implementation.
   - Add `EXTENDS` relationship: `Class → Class`.
   - Add `IMPLEMENTS` relationship: `Class → Interface`.
   - Apply to JS/TS (`extends`, `implements` clauses) and Python (base class list).
   - Go struct embedding and Rust trait `impl` as stretch goals.
   - Add fixture and tests.

### 5d — Re-export tracking

26. [ ] Track JS/TS re-exports.
   - Handle `export { foo } from './bar'` — add `IMPORTS` + `RESOLVES_TO` edges.
   - Handle `export * from './bar'` — add a wildcard re-export edge.
   - Prevents import chain gaps at barrel files.
   - Add fixture and tests.

### 5e — Package boundary resolution

27. [ ] Resolve `package.json` exports, main, and types fields.
   - Read `package.json` `exports`, `main`, and `types` to resolve package-style imports.
   - Fills the gap left by task 10 for Node.js package boundaries.
   - Add fixture and tests.

### 5f — Visibility granularity

28. [ ] Add `visibility` property to Function and Class nodes.
   - TypeScript: `"private"`, `"protected"`, `"public"` (default `"public"`).
   - Rust: `"pub"`, `"pub(crate)"`, `"pub(super)"`, `"private"`.
   - Python: `"private"` (leading `_`), `"dunder"` (leading `__`), `"public"`.
   - Go: `"exported"` (uppercase) or `"unexported"`.
   - Supersedes the boolean `isExported` for finer-grained queries.
   - Update fixture assertions.

## Long-Term Development Goals

These items require significant architectural work or external integrations and are tracked
separately as future investment areas rather than near-term tasks.

### Incremental Scanning

- Avoid full re-scans by tracking file content hashes between runs.
- Only re-parse files whose hash has changed since the last scan.
- Update only the affected nodes and relationships in the graph.
- Critical for large codebases where full scans take too long to be practical.

### MCP Server

- Expose the graph as a Model Context Protocol (MCP) tool.
- Allow Claude and other MCP clients to query the code graph directly in natural language.
- Potential tools: `find_callers`, `find_definitions`, `list_exports`, `trace_import_chain`.
- Turns Concentrate into an always-on code intelligence layer for AI-assisted development.

## Current Priority

Milestones 4 and 5a are complete. Continue Milestone 5 with task 24 (TypeScript
interfaces, type aliases, and enums) or task 25 (class inheritance and implementation).
