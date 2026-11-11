# Concentrate Roadmap: Minimal Runtime Dependencies

> Progress is tracked both here and in the linked GitHub issues. When a PR completes a task, tick it
> in this file **and** in the issue. The tracking epic is [#1](https://github.com/fatihserhatturan/concentrate/issues/1).

## Context

Concentrate scans a codebase, builds a structural code graph and serves it to AI agents over MCP.
It started with 10 runtime dependencies: commander, fast-glob, ignore, kuzu, tree-sitter and five
grammar packages. KuzuDB was archived in October 2025 (last release 0.11.3), and the native
tree-sitter binding needs prebuilt or locally compiled addons, which makes installation fragile.
Phase 3a replaced the native binding with web-tree-sitter (WebAssembly) and vendored grammars, so
the only runtime dependency left is `web-tree-sitter`.

### Decisions

- **Minimal runtime dependencies.** `dependencies` in `package.json` holds only `web-tree-sitter`,
  pinned to an exact version: plain JS and WebAssembly, no dependencies of its own and no install
  scripts. Nothing else is added. Dev dependencies (typescript, @types/node, tsx, tree-sitter-cli)
  are allowed.
- **tree-sitter on WebAssembly, not own parsers.** Grammars are built to `.wasm` from pinned versions
  (`npm run grammars:build`) and committed under `vendor/grammars/`. Writing our own JS/TS, Python,
  Go and Rust parsers was the original plan (Phases 3b–3d); it was dropped on 2026-10-27 because the
  install problem was the native binding, not tree-sitter, and hand-written parsers would need
  permanent upkeep for every TypeScript release. See [benchmarks.md](benchmarks.md#parser-native-vs-wasm).
- **Own graph engine.** In-memory graph, segmented on-disk snapshots and a Cypher subset. No
  `node:sqlite` (still experimental).
- **Stable `node:` APIs only.**
- **Enforced by tests.** `tests/guardrails.test.ts` fails if `src/` imports a package outside
  `RUNTIME_DEPENDENCY_ALLOWLIST`, if an allow-listed package is no longer used, if a runtime
  dependency is not pinned or has install scripts or dependencies, or if anything but
  `src/integrations/languages/syntax/tree-sitter.ts` imports web-tree-sitter.
  `tests/grammars.test.ts` checks the vendored grammars against their manifest.
- **Focus.** The Node.js/TypeScript backend niche first, then the whole JS/TS ecosystem including the
  frontend (M8), then the Go ecosystem (M9), the non-code files of a project (M10), the Rust
  ecosystem (M11), the Python ecosystem (M12) and the C/C++ ecosystem (M13).

### Dependency replacement map

| Dependency | Used in | Replacement | Phase |
| --- | --- | --- | --- |
| commander | `src/index.ts` | `node:util` `parseArgs` router | 1 |
| fast-glob | `core/scan/discover-files.ts`, `workspace-packages.ts`, `js-ts/resolution/package-json.ts` | Own glob + `fs.readdir` walker | 1 |
| ignore | `core/scan/discover-files.ts` | Own gitignore matcher (nested `.gitignore`) | 1 |
| kuzu | `adapters/kuzu/*` | Own graph store + Cypher subset | 2 |
| tree-sitter + 5 grammars | 22 files | web-tree-sitter (pinned) + vendored `.wasm` grammars | 3a |

## Milestones

| Milestone | Phases | Done when |
| --- | --- | --- |
| M1 – Safety net & easy deps | 0, 1 | Golden tests green; commander, fast-glob and ignore removed. |
| M2 – Own graph engine | 2 | All golden Cypher queries match; kuzu removed. |
| M3 – Portable parser | 3a, 4 | tree-sitter runs on WebAssembly with no native install step; route semantics moved into the framework layer. |
| M4 – Current grammars | 3b, 3e | Grammars upgraded with reviewed golden diffs, TSX and partial-tree error tolerance; parser performance documented. |
| M5 – Incremental & agent tools | 5, 6a | Real incremental scan, watch mode, and the first agent-facing MCP tools. |
| M6 – Release | 8, 9 | Published to npm with a benchmarked README and CI. |
| M7 – Niche depth | 6b, 7 | Deeper Node.js/TS backend semantics and the remaining MCP tools. |
| M8 – Full JS/TS ecosystem | 10–17 | Frontend frameworks (React/Next.js, Vue/Nuxt, Svelte/SvelteKit, Astro, Angular) and vanilla JS: components, pages, frontend → backend API links, stores and DOM events. |
| M9 – Go ecosystem | 18–21 | Go modules, packages and calls resolved; net/http, gin, echo, chi, fiber and gorilla/mux routes, gRPC and cobra entrypoints; database/sql, sqlx, gorm, env and HTTP clients; measured on pinned samples. |
| M10 – Non-code files | 22–25 | Every file in the graph (styles, JSON, YAML, shell, PowerShell, Dockerfile, Makefile, SQL, `.proto`) with vendored tree-sitter grammars; scripts and infrastructure as entrypoints with their env; CSS linked to components; SQL tables and `.proto` services; measured on pinned samples. |
| M11 – Rust ecosystem | 26–29 | Cargo workspaces, path calls, traits and attributes; axum, actix-web, Rocket and warp routes; sqlx, diesel, SeaORM, env and reqwest; measured on pinned samples. |
| M12 – Python ecosystem | 30–33 | Python packages, classes, decorators and typed calls; Django, Flask, FastAPI, Celery and click/typer entrypoints; SQLAlchemy, Django ORM, env, HTTP clients and DI; measured on pinned samples. |
| M13 – C/C++ ecosystem | 34–37 | C and C++ includes, headers, namespaces, classes and virtual calls; CMake, Make and `compile_commands.json` targets; Drogon, Crow, Pistache, cpp-httplib, gRPC and Qt; SQL, env and libcurl; measured on pinned samples. |

M8 and the agent benchmark v2 ([#73](https://github.com/fatihserhatturan/concentrate/issues/73), two models,
per-category results) are done. The M6 release (Phase 9) is not planned for now. Order from here:
M9 (Go), M10 (non-code files), M11 (Rust) and M12 (Python) are done. M13, the C/C++ ecosystem, has its
language foundation (Phase 34); the build systems (Phase 35) come next.

Risks: grammar upgrades changing trees (bounded by golden graph and query tests), Cypher subset
breadth (bounded by golden queries), and performance (worker pool if needed).

## Phase 0: Safety net (golden tests, samples, dependency guardrail, store contracts) ([#2](https://github.com/fatihserhatturan/concentrate/issues/2))

**Milestone:** M1 – Safety net & easy deps  
**Depends on:** none

**Goal:** Make every later change measurable before any dependency is replaced.

The parser and storage rewrites in later phases are only safe if graph output can be diffed automatically. Today the standing smoke suite cannot run because the sample repositories are missing from disk, and nothing prevents new runtime dependencies from being added.

### Golden graph tests

- [x] Add a normalized JSONL graph export (stable ordering, absolute paths stripped) usable from tests
- [x] Record golden graphs for every fixture under `tests/golden/fixtures/`
- [x] Record golden graphs for every standing sample repository under `tests/golden/samples/`
- [x] Add `tests/golden.test.ts` that diffs current output against the golden files with a readable diff
- [x] Add an `--update-golden` (or `UPDATE_GOLDEN=1`) flow and document when it is acceptable to use

### Sample repositories

- [x] Add `scripts/fetch-samples.mjs` that clones express, fastify, nestjs and ky using only `git`
- [x] Pin each sample to a commit SHA and record it in `docs/sample-repositories.md`
- [x] Make sample paths configurable (env var or `.concentrate/samples/`) instead of hard-coded Desktop paths
- [x] Verify `npm run smoke:samples -- --suite standing` passes end to end

### Golden query results (reference for the new engine)

- [x] Record every Cypher statement the MCP tools issue and pin the distinct query shapes in `tests/golden/queries/templates.json`
- [x] Run them against Kuzu on every standing sample and store normalized results under `tests/golden/queries/`

### Dependency guardrail

- [x] Add a guardrail test: every bare import in `src/` must start with `node:` or be in a shrinking allow-list
- [x] Add a guardrail test: `package.json` `dependencies` must be a subset of the same allow-list
- [x] Document that the allow-list must only shrink and must be empty at the end of M4

### Store contracts

- [x] Add `IGraphStore` (open, write, patch, stats, close) to `src/core/contracts/`
- [x] Add `IQueryEngine` (`query(cypher)`, `stats`, `schemaVersion`, `close`) to `src/core/contracts/`; `$param` support lands with Phase 2
- [x] Make the existing Kuzu adapter implement both contracts and route CLI/MCP through them

### Acceptance criteria

- [x] Golden fixture, sample and query tests run in `npm test` and pass
- [x] Standing smoke suite runs from a fresh clone via the fetch script
- [x] Guardrail fails if a new runtime dependency is imported
- [x] CLI and MCP depend only on `IGraphStore` / `IQueryEngine`, not on Kuzu types

## Phase 1: Replace commander, fast-glob and ignore with built-ins ([#3](https://github.com/fatihserhatturan/concentrate/issues/3))

**Milestone:** M1 – Safety net & easy deps  
**Depends on:** Phase 0

**Goal:** Remove the three easiest runtime dependencies using stable `node:` APIs.

commander is used only in `src/index.ts`; fast-glob in `core/scan/discover-files.ts`, `core/scan/workspace-packages.ts` and `integrations/languages/js-ts/resolution/package-json.ts`; ignore only in `core/scan/discover-files.ts`, which currently reads just the root `.gitignore`.

### CLI argument parsing (commander → `node:util` parseArgs)

- [x] Add `src/adapters/cli/args.ts`: sub-command router on top of `parseArgs`
- [x] Support repeatable flags (`--include a --include b`), number validation and defaults
- [x] Generate `--help` output for the root command and every sub-command
- [x] Port every command in `src/commands/*` to the new router without changing flags
- [x] Add CLI parsing tests (unknown flag, missing value, repeatable flags, help)

### Glob matching (fast-glob → own walker)

- [x] Add `src/core/scan/glob.ts` supporting `**`, `*`, `?`, `{a,b}`, `[...]` and `!` negation with cached RegExps
- [x] Walk directories with `fs.readdir` and prune ignored directories early
- [x] Port `discover-files.ts`, `workspace-packages.ts` and `package-json.ts` to the new glob
- [x] Add a spec-table test suite for glob semantics

### Ignore rules (ignore → own gitignore matcher)

- [x] Add `src/core/scan/gitignore.ts` implementing anchors, `dir/`, `**`, negation and escapes
- [x] Respect nested `.gitignore` files (behavior improvement over today)
- [x] Add a spec-table test suite inspired by git's own ignore test cases

### Cleanup

- [x] Remove commander, fast-glob and ignore from `package.json` and the guardrail allow-list
- [x] Confirm golden graph diff is empty (or document intentional changes from nested `.gitignore`)

### Acceptance criteria

- [x] `commander`, `fast-glob` and `ignore` no longer appear in `package.json` or `src/`
- [x] All CLI commands behave as before (help, flags, exit codes)
- [x] Golden tests pass; any diff is explained in the PR

## Phase 2: Own in-memory graph engine and Cypher subset (remove kuzu) ([#4](https://github.com/fatihserhatturan/concentrate/issues/4))

**Milestone:** M2 – Own graph engine  
**Depends on:** Phase 0

**Goal:** Replace the archived KuzuDB with a zero-dependency graph store and query engine.

KuzuDB was archived in October 2025 (last release 0.11.3). The Kuzu adapter was ~1.5k lines under `src/adapters/kuzu/`, and the distinct query shapes the MCP tools issue are pinned in `tests/golden/queries/templates.json`. Graph sizes (tens of thousands of nodes) fit comfortably in memory.

### In-memory model (`src/adapters/store/`)

- [x] Node map by id, label index, and property indexes for `name`, `relativePath`, `method` and `path`
- [x] Outgoing/incoming adjacency lists (filtered by relationship type while expanding)
- [x] Validate labels and properties against `schema.ts`; schema version 35 for the new format

### Persistence

- [x] Versioned on-disk format under `.concentrate/graph/` with a header
- [x] Segment data by owning source file, plus one global segment for cross-file resolution edges
- [x] Compress segments with `node:zlib`
- [x] Atomic writes (write to temp file, then rename)
- [x] Patch rewrites only changed file segments and the global segment

### Concurrency

- [x] Writer lock file with pid and stale-lock detection
- [x] Lock-free readers via atomic snapshots
- [x] Delete `kuzu-retry.ts` and its tests once the new store is in place

### Cypher subset (`src/adapters/store/cypher/`)

- [x] Lexer and parser producing an AST
- [x] `MATCH` / `OPTIONAL MATCH` chains, anonymous nodes, relationship variables and `[:A|B]`
- [x] Variable-length paths `*min..max`
- [x] `WHERE`: comparisons, `AND`/`OR`/`NOT`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN`, `IS NULL`, `lower`/`toLower`
- [x] `contains()` and `lower()` function calls (used by MCP name and model filters)
- [x] `WITH ... AS` projection (used by the data-access queries)
- [x] `RETURN ... AS`, `DISTINCT`, `count` / `collect` / `min` / `max`
- [x] `ORDER BY`, `SKIP`, `LIMIT` and `$param` parameters
- [x] Planner that starts from the most selective index
- [x] Read-only query surface; writes go through `IGraphStore` only
- [x] Clear error messages for unsupported Cypher features

### Migration

- [x] Replay every recording in `tests/golden/queries/` against the new engine and match rows and tool output exactly
- [x] Port `scan`, `stats`, `query`, `export`, `smoke` and `mcp` to the new store
- [x] Delete `src/adapters/kuzu/` and remove `kuzu` from dependencies and the allow-list
- [x] Benchmark scan-write time and query latency against the Kuzu baseline

### Acceptance criteria

Done in [#20](https://github.com/fatihserhatturan/concentrate/pull/20), [#21](https://github.com/fatihserhatturan/concentrate/pull/21) and the store switch PR; numbers in [benchmarks.md](benchmarks.md), the supported subset in [cypher.md](cypher.md).

- [x] All golden query recordings (every shape in `templates.json`, fixtures and standing samples) match exactly
- [x] `kuzu` is gone from `package.json` and `src/`
- [x] Concurrent `mcp` reader and `scan` writer work without lock errors
- [x] Query latency for MCP tools is equal to or better than the Kuzu baseline

## Phase 3a: tree-sitter on WebAssembly ([#5](https://github.com/fatihserhatturan/concentrate/issues/5))

**Milestone:** M3 – Portable parser  
**Depends on:** Phase 0

**Goal:** Keep tree-sitter but drop the native binding, so installing Concentrate never compiles or downloads native code.

Extractors use only a narrow tree-sitter API: `type`, `id`, `text`, `startPosition`, `endPosition`, `namedChildren`, `children`, `childForFieldName`, `parent`, `hasError` and `rootNode`. web-tree-sitter exposes the same API.

### Syntax module (`src/integrations/languages/syntax/tree-sitter.ts`)

- [x] `SyntaxNode` / `SyntaxTree` types; extractors no longer import `tree-sitter` types
- [x] Lazy `Parser.init()` and grammar loading; `parseSyntaxTree` / `withSyntaxTree` free trees with `delete()` (WebAssembly memory is not garbage collected)
- [x] Node comparisons by `id` (`indexOfNode`), since node objects are wrappers created on access
- [x] Whole-string input; the 32 KB chunked-input workaround for the native binding is gone

### Grammars (`vendor/grammars/`)

- [x] `scripts/build-grammars.mjs` downloads each grammar with `npm pack` (no install scripts) and builds it with the pinned `tree-sitter-cli`; builds are reproducible
- [x] Same grammar versions as the native setup: javascript 0.23.1, typescript 0.23.2, python 0.21.0, go 0.21.2, rust 0.21.0
- [x] `manifest.json` with version and sha256 per grammar, checked by `tests/grammars.test.ts`

### Acceptance criteria

- [x] Golden graph, golden query and sample tests pass unchanged
- [x] `npm ci --omit=dev --ignore-scripts` installs only `web-tree-sitter` (4.5 MB, was 67 MB) and `scan` works
- [x] Scan time ≤ 1.5× native on every standing sample (it is 0.4–0.9×, see [benchmarks.md](benchmarks.md#parser-native-vs-wasm))
- [x] Repeated scans in one process do not grow memory

## Phase 3b: Grammar upgrades, TSX and error tolerance

**Milestone:** M4 – Current grammars  
**Depends on:** Phase 3a

**Goal:** Move to current grammar releases and stop rejecting whole files on a syntax error.

### Grammars

- [ ] Upgrade javascript (0.25), python (0.25), go (0.25), rust (0.24) and typescript to current releases; review and document each golden diff
- [x] Parse `.tsx` with the TSX grammar (done in Phase 10, [#75](https://github.com/fatihserhatturan/concentrate/issues/75)).

### Error tolerance (behavior improvement)

- [x] Produce a partial graph plus a scan warning instead of rejecting a file whose tree has `ERROR` nodes (JS/TS, done in Phase 10, [#75](https://github.com/fatihserhatturan/concentrate/issues/75)).
- [ ] Document the resulting golden diffs

### Integration

- [ ] Add `endLine` to JS/TS `Variable` and `Route` nodes (functions, classes, interfaces, enums and type aliases already have it)

### Acceptance criteria

- [ ] Golden diffs are reviewed and explained in the PR
- [x] `internet-nest` files that fail today on syntax errors produce partial graphs (the 2 microservices decorator specs)

## Phase 3e: Parser performance ([#9](https://github.com/fatihserhatturan/concentrate/issues/9))

**Milestone:** M4 – Current grammars  
**Depends on:** Phase 3a

**Goal:** Keep scan time competitive as repositories grow.

### Measurement

- [x] Record native and WASM scan time and peak memory on each standing sample
- [x] Add a repeatable parser benchmark script to `scripts/` (`npm run bench:parser`, `scripts/bench-parser.ts`)

### Optimization

- [x] Add an optional `node:worker_threads` pool for per-file parsing if profiles show parsing dominates (parse plus extraction is 80–90% of a scan; automatic from 100 files to parse, `--workers`; see [benchmarks.md](benchmarks.md#parser-benchmark-and-parse-workers))

### Acceptance criteria

- [x] Benchmark results are documented
- [x] Scan time on `internet-nest` does not regress across grammar upgrades (`npm run bench:parser -- --baseline`, see [benchmarks.md](benchmarks.md#grammar-upgrades))

## Phase 4: Move framework route knowledge out of the language layer ([#10](https://github.com/fatihserhatturan/concentrate/issues/10))

**Milestone:** M3 – Portable parser  
**Depends on:** Phase 3a

**Goal:** Keep the language layer framework-agnostic and use a single parser per language.

Before this phase, `src/integrations/languages/js-ts/routes.ts` (830 lines) and `entrypoints.ts` held the Express/Koa/Fastify/NestJS and queue/cron/socket.io knowledge, `calls.ts` held Fastify's hook names, and the registry kept two parser sets per language (scan vs. integration).

### Route and entrypoint semantics

- [x] Move Express/Koa/Fastify/NestJS route detection into `frameworks/js-ts/route-graph.ts`
- [x] Move framework-specific entrypoint detection into `frameworks/js-ts/entrypoint-graph.ts`; shared file lookups live in `frameworks/js-ts/file-index.ts`
- [x] Keep only generic call/argument structures in the language layer; callback object keys such as Fastify's `handler` and hooks are declared by the framework plugin (`callbackPropertyNames`)

### Plugin model

- [x] `JsTsFrameworkPlugin.onFile({ fileNodeId, rootNode, parsed, state })` runs on the shared tree; `createJsTsParser(language, plugins)` builds the one JS/TS parser, and `frameworks/js-ts/scanner.ts` lists the plugins in order
- [x] Remove the dual scan/integration parser registration from `default-registry.ts`
- [x] Remove `getLanguageIntegration`

### Guardrails

- [x] `tests/guardrails.test.ts` fails if framework or library names appear in `integrations/languages/`

### Acceptance criteria

- [x] One parser per language in the registry
- [x] No framework-specific code in `integrations/languages/`
- [x] Golden tests pass unchanged

## Phase 5: Real incremental scanning and watch mode ([#11](https://github.com/fatihserhatturan/concentrate/issues/11))

**Milestone:** M5 – Incremental & agent tools  
**Depends on:** Phase 2

**Goal:** Re-parse only what changed and keep the graph fresh automatically.

Before this phase, `createParsePlan` always returned `effectiveMode: "full"`, and `scan --incremental changed-files` parsed every file and then patched the store per file, which left cross-file results (resolved calls, route paths from imported constants) stale in unchanged files.

### Changed-file parsing

- [x] Per-file parse cache at `.concentrate/cache/<project>/<key>.json` (`src/core/scan/parse-cache.ts`); on by default, `--cache-dir`, `--no-cache`
- [x] Unchanged files reuse cached results, added/changed files are parsed; unused entries are pruned
- [x] Global resolution passes and contributors re-run over the merged graph on every scan, and the store is rewritten as a whole
- [x] Invalidation by key: the parser fingerprint hashes Concentrate's code, the vendored grammars and the schema version (`src/composition/parser-fingerprint.ts`)
- [x] `tests/parse-cache.test.ts`: cached scan equals a full scan for add, change, delete and rename, including a route whose path comes from another file, and on every fixture
- [x] Removed the manifest diff, parse plan, `--previous-manifest`, `--incremental` and the store's per-file `patch`

### Watch mode

- [x] Add `concentrate watch` using `fs.watch({ recursive: true })` with debouncing (`--debounce`, default 200 ms); changes under `.git`, `node_modules`, `.concentrate` and its own outputs are ignored
- [x] Rescan with the parse cache on changes and rewrite the store; a scan that fails fast keeps the last graph
- [x] Let a running MCP server reload when the store changes (readers check the store HEAD on every call since Phase 2)

### Acceptance criteria

- [x] Incremental scan output equals a full scan in all tested scenarios (and on every sample, `npm run benchmark:incremental`)
- [x] A no-change incremental scan is substantially faster than a full scan on the standing samples (3.5–6×, see [benchmarks.md](benchmarks.md#parse-cache))
- [x] `watch` keeps the graph current while files are edited (`tests/watch.test.ts`)

## Phase 6a: Agent-facing MCP tools (impact, changes, routes, source) ([#12](https://github.com/fatihserhatturan/concentrate/issues/12))

**Milestone:** M5 – Incremental & agent tools  
**Depends on:** Phase 2

**Goal:** Answer the questions agents actually ask with a single tool call.

MCP exposed 9 tools before this phase: graph_stats, find_definitions, find_callers, list_exports, trace_import_chain, list_routes, list_entrypoints, list_env_config and list_data_access. This phase adds 5 more (see [mcp-server.md](mcp-server.md#agent-tools)).

### New tools

- [x] `impact_of(symbol | file)`: transitive callers plus affected routes, entrypoints, tables and env vars (for a route, `route_details` gives its downstream)
- [x] `detect_changes`: `git diff` via `node:child_process` → changed line ranges → symbols → impact report
- [x] `route_details(method, path)`: handler → middleware → call chain → data access → env/config
- [x] `get_symbol_source` and `get_file_outline` using `line`/`endLine`

### Tests

- [x] Unit tests for each tool against fixtures (`tests/mcp-agent-tools.test.ts`, golden recordings in `tests/golden/queries/`)
- [x] End-to-end JSON-RPC test over stdio for each new tool

### Acceptance criteria

- [x] All new tools are listed by `tools/list` and covered by tests
- [x] Tool output stays within a documented size budget (24,000 characters, see [mcp-server.md](mcp-server.md#output-budget))

## Phase 6b: Analysis tools and MCP protocol quality ([#13](https://github.com/fatihserhatturan/concentrate/issues/13))

**Milestone:** M7 – Niche depth  
**Depends on:** Phase 6a

**Goal:** Round out the MCP surface and align with the current protocol spec.

The MCP server is a hand-written JSON-RPC layer in `src/adapters/mcp/server.ts`. It speaks MCP 2026-07-28 (`server/discover`, per-request `_meta` version) and the legacy `initialize` versions back to 2024-11-05; list tools page with cursors and stay under a 24,000-character budget.

### Search and navigation

- [x] `search_symbols`: fuzzy name search with ranking
- [x] `find_references`

### Analysis

- [x] Import cycle detection
- [x] Unused exports / dead code
- [x] Architecture overview at package and directory level

### Protocol quality

- [x] Output token budget and pagination for every tool
- [x] Structured output (`structuredContent`)
- [x] Expose a graph summary as an MCP resource
- [x] Align the JSON-RPC layer with the current MCP specification version

### Acceptance criteria

- [x] New tools are covered by unit and stdio end-to-end tests
- [x] Every tool supports pagination and respects the output budget

## Phase 7: Niche depth – Node.js/TS backend semantics ([#14](https://github.com/fatihserhatturan/concentrate/issues/14))

**Milestone:** M7 – Niche depth  
**Depends on:** Phase 4

**Goal:** Own the question "which tables and env vars does this endpoint touch, and what breaks if it changes?"

Concentrate already models Express/Koa/Fastify/NestJS routes, NestJS DI, env usage and Prisma/TypeORM/Sequelize/Knex/Mongoose access. This phase deepens that niche.

### Frameworks

- [ ] Hono routes
- [ ] Next.js app router `route.ts` handlers and server actions. Moved to Phase 12 ([#77](https://github.com/fatihserhatturan/concentrate/issues/77)).
- [ ] tRPC procedures. Moved to Phase 13 ([#78](https://github.com/fatihserhatturan/concentrate/issues/78)).
- [ ] GraphQL resolvers (Apollo, NestJS)
- [ ] NestJS guards, interceptors and pipes
- [ ] Ordered middleware chains

### Data layer

- [x] Parse `schema.prisma` (models → tables, relations)
- [x] Drizzle ORM
- [x] Table nodes for TypeORM entities and Mongoose schemas
- [x] Unified `Table` node with `READS` / `WRITES` edges

### Cross-service

- [ ] Match outbound HTTP calls (fetch, axios) to routes inside a monorepo. Moved to Phase 13 ([#78](https://github.com/fatihserhatturan/concentrate/issues/78)).
- [ ] BullMQ producer/consumer matching
- [ ] EventEmitter emit/on matching

### Environment

- [ ] Parse `.env*` files
- [ ] Minimal own YAML reader for `docker-compose.yml` environment sections

### Call resolution quality

- [ ] Lightweight TS type inference from annotations, `new`, DI and return types
- [ ] Add a `confidence` property to `CALL_RESOLVES_TO`

### Acceptance criteria

- [ ] Each new framework/data source has fixtures and golden coverage
- [ ] Accuracy report (Phase 8) shows no regression and improved recall

## Phase 8: Quality measurement and benchmarks ([#15](https://github.com/fatihserhatturan/concentrate/issues/15))

**Milestone:** M6 – Release  
**Depends on:** Phase 0

**Goal:** Quantify accuracy, performance and agent value so the README can lead with numbers.

Builds on the existing `--semantic-samples` infrastructure in the smoke command.

### Accuracy

- [x] Hand-label routes, calls and data-access edges on the standing samples ([accuracy.md](accuracy.md))
- [x] Report precision and recall per relationship type (`npm run bench:accuracy`)

### Performance

- [x] Report scan time, peak memory and query latency per release (`npm run bench:release`)

### Agent benchmark

- [x] Define a fixed question set across the sample repositories ([agent-benchmark.md](agent-benchmark.md))
- [x] Measure tokens, tool calls and answer accuracy with and without Concentrate (`npm run bench:agent`)
- [x] Publish results in the README and `docs/`

### Acceptance criteria

- [x] Accuracy, performance and agent benchmark reports are reproducible from scripts
- [x] README shows the headline numbers

## Phase 9: Distribution (npm, init command, CI) ([#16](https://github.com/fatihserhatturan/concentrate/issues/16))

**Milestone:** M6 – Release  
**Depends on:** Phase 3a

**Goal:** Make `npx concentrate` work everywhere with no native build.

Requires the portable parser (M3): the only runtime dependency is `web-tree-sitter`. Only stable `node:` APIs may be used; no `node:sqlite`.

### Package

- [ ] Set `bin` and `engines: node >=22`; drop `private: true` (`files` and the single pinned dependency are done)
- [ ] Choose a license and add `LICENSE`
- [ ] Verify `npm pack` then `npx ./concentrate-*.tgz scan` in a clean directory without native builds

### Onboarding

- [ ] Add `concentrate init` writing MCP config for Claude Code, Cursor and Codex
- [ ] Rewrite the README around install, MCP setup and benchmark results

### CI

- [ ] GitHub Actions matrix: Node 22/24 × macOS/Linux/Windows
- [ ] Run typecheck, tests (golden, parity, guardrails) and build on every PR
- [ ] Release workflow publishing to npm on tags

### Optional

- [ ] Single-file executable via Node SEA

### Acceptance criteria

- [ ] Package is published to npm
- [ ] CI is green on all matrix targets
- [ ] `concentrate init` produces a working MCP setup

## M8: Full JS/TS ecosystem

Phases 10–17 extend the graph from the Node.js backend to the whole JS/TS ecosystem: frontend
frameworks, vanilla JS and the links between frontend and backend.

### Decisions

- **Still one runtime dependency.** The only new grammars are `tsx` (from the pinned
  `tree-sitter-typescript` package) and the official `tree-sitter-html`, vendored as `.wasm` through
  `npm run grammars:build`.
- **No Vue, Svelte or Astro grammars.** An own single-file-component splitter extracts `<script>`
  blocks and Astro frontmatter with their offsets and parses them with the JS/TS grammar; templates
  are parsed with the HTML grammar. Line numbers point into the original file.
- **One framework-neutral schema.** New labels: `Component`, `Page` and `Store`. New relationships:
  `RENDERS`, `USES_HOOK`, `PAGE_RENDERS`, `REQUESTS` (Call → Route), `READS_STORE` and
  `WRITES_STORE`. DOM events reuse `EntryPoint` (kind `dom-event`); server handlers of full-stack
  frameworks (Next.js `route.ts`, Nuxt `server/api`, SvelteKit `+server.ts`, Astro endpoints) reuse
  `Route`. Each phase bumps `SCHEMA_VERSION`.
- **Measured like the backend.** Every phase adds a pinned sample with hand labels to
  `bench:accuracy`; precision stays at 100% and recall is reported. The RealWorld "Conduit"
  frontends are the first candidates: they share their API with `internet-node-express-realworld`,
  so frontend → backend links can be measured end to end.

## Phase 10: Frontend file foundation (TSX, HTML, single-file components, vanilla JS) ([#75](https://github.com/fatihserhatturan/concentrate/issues/75))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 3a ([#5](https://github.com/fatihserhatturan/concentrate/issues/5))

**Goal:** Parse every file a JS/TS frontend is made of, without rejecting files on a syntax error.

Today `.tsx` is parsed with the TypeScript grammar, which has no JSX (`src/core/scan/language.ts`), and a file whose tree has `ERROR` nodes is rejected, so most React components produce no graph. `.html`, `.vue`, `.svelte` and `.astro` files are not read at all. This phase takes over the TSX and error-tolerance items of Phase 3b and adds the file layer every later M8 phase builds on.

### Grammars

- [x] Parse `.tsx` with the TSX grammar (built from the pinned `tree-sitter-typescript` package, `tsx` directory)
- [x] Vendor the official `tree-sitter-html` grammar as `.wasm` through `npm run grammars:build`
- [x] Produce a partial graph plus a scan warning instead of rejecting a file whose tree has `ERROR` nodes; review the golden diffs

### Single-file components

- [x] Own SFC splitter for `.vue`, `.svelte` and `.astro`: extract `<script>` blocks and Astro frontmatter with their line and column offsets and parse them with the JS/TS grammar
- [x] Parse the template part with the HTML grammar; Vue directives, Svelte blocks and Astro expressions are read as attributes or text
- [x] Graph line numbers point into the original file; `File.language` records `vue`, `svelte`, `astro` or `html`

### Vanilla JS

- [x] `<script src>` and `<script type="module">` in `.html` files become `IMPORTS` / `RESOLVES_TO`; inline `<script>` blocks are parsed
- [x] `addEventListener(...)` and `on*` attributes become `EntryPoint` nodes (kind `dom-event`, trigger = event name) linked to their handler
- [x] `customElements.define('x-tag', Class)` becomes a `Component` (kind `web-component`)

### Acceptance criteria

- [x] Fixtures for TSX, a file with a syntax error, each SFC format and a vanilla HTML page, with golden coverage
- [x] `internet-nest` files that failed on syntax errors produce partial graphs (the 2 microservices decorator specs)
- [x] Precision stays at 100% in `bench:accuracy`; parse time per file is reported in `docs/benchmarks.md`

## Phase 11: Component model and React ([#76](https://github.com/fatihserhatturan/concentrate/issues/76))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 10

**Goal:** Answer "what renders this component, what does it render, and which hooks does it use?" for React code.

This phase introduces the framework-neutral component schema that the Vue, Svelte, Astro and Angular phases reuse: a `Component` node, `RENDERS` and `USES_HOOK` relationships. React comes first because JSX and TSX are already parsed after Phase 10.

### Schema

- [x] `Component` label (name, framework, kind, line, endLine, isExported), defined by the file that declares it
- [x] `RENDERS` (Component → Component, with the props names); bump `SCHEMA_VERSION`
- [x] `USES_HOOK` (from the component's or hook's Function → Function) and `USES_CONTEXT` (Function → context Component)

### React

- [x] Function and class components: JSX return, `React.FC` / `FC` annotations, `memo` and `forwardRef` wrappers
- [x] `lazy(() => import(...))` components
- [x] JSX `<Child prop=…>` resolves through imports and barrels to the child `Component`
- [x] Built-in and custom hooks (`use*`) resolve through call resolution to `USES_HOOK`
- [x] `createContext` providers and `useContext` consumers

### MCP

- [x] `component_tree`: renders / rendered by, props, hooks
- [x] `find_component_usages`: every place a component is rendered
- [x] `impact_of` follows `RENDERS` upwards

### Acceptance criteria

- [x] Fixtures and golden coverage for each component form and for hooks across files
- [x] A pinned React sample (candidate: a RealWorld "Conduit" React frontend) with hand labels for components and `RENDERS` in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 12: Pages, client routing and Next.js ([#77](https://github.com/fatihserhatturan/concentrate/issues/77))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 11

**Goal:** Map every URL a frontend serves to the page and components behind it, and Next.js server handlers to routes.

Adds a `Page` node for client-visible URLs. Server-side handlers of full-stack frameworks keep the existing `Route` label. Takes over the Next.js item of Phase 7 (#14).

### Schema

- [x] `Page` label (path, fullPath, framework, kind: page / layout / loading / error / not-found) and `PAGE_RENDERS` (Page → Component); bump `SCHEMA_VERSION`

### Next.js

- [x] `app/` router: `page`, `layout`, `loading`, `error`, route groups, dynamic and catch-all segments, parallel routes
- [x] `pages/` router, including `_app` and `_document`
- [x] `app/**/route.ts` handlers and `pages/api/**` become `Route` nodes with methods
- [x] Server actions (`"use server"`) and `middleware.ts` with its `matcher`

### Client routers

- [x] React Router: JSX `<Route>` trees and `createBrowserRouter` objects, nested paths
- [x] TanStack Router file and code routes

### MCP

- [x] `list_pages`
- [x] `route_details` and `impact_of` include pages

### Acceptance criteria

- [x] Fixtures and golden coverage for both Next.js routers and both client routers
- [x] A pinned Next.js sample with hand labels for pages and route handlers in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 13: Frontend → backend API links ([#78](https://github.com/fatihserhatturan/concentrate/issues/78))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 10, Phase 11

**Goal:** Answer "which frontend code calls this endpoint?" and follow a change across the frontend–backend boundary.

Links outbound HTTP calls to the `Route` nodes the backend phases already build. Takes over the "match outbound HTTP calls to routes" and tRPC items of Phase 7 (#14). Precision comes first: dynamic or ambiguous URLs are left unlinked. Includes #58 (destructured `process.env` reads) and #59 (`import.meta.env`).

### Schema

- [x] `REQUESTS` (Call → Route, with method, url and how the match was made); bump `SCHEMA_VERSION`

### Clients

- [x] `fetch`, `axios` (including instances created with `baseURL`), `ky`, `ofetch` / `$fetch`
- [x] SWR and TanStack Query keys and fetchers
- [x] tRPC: client procedure calls to router procedures

### Matching

- [x] URLs from literals, template strings and constants; base URLs from config and env
- [x] Match against `Route.fullPath` with method and parameter segments, across packages in a monorepo
- [x] Env: destructured reads (#58), `import.meta.env` (#59), `NEXT_PUBLIC_*` and `VITE_*`

### MCP

- [x] `api_consumers`: the frontend calls that reach a route
- [x] `impact_of` and `route_details` cross from routes to their callers and back

### Acceptance criteria

- [x] Fixtures and golden coverage for each client and for an unmatched dynamic URL
- [x] The RealWorld frontend sample linked to `internet-node-express-realworld`, with hand labels for `REQUESTS` in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 14: Vue and Nuxt ([#79](https://github.com/fatihserhatturan/concentrate/issues/79))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 11, Phase 13

**Goal:** The component, page, API and store graph for Vue and Nuxt applications.

Builds on the SFC splitter (Phase 10), the component schema (Phase 11), the page schema (Phase 12) and API links (Phase 13). Introduces the `Store` node, which Phases 15 and 17 reuse.

### Vue

- [x] Components from `.vue` files: `<script setup>`, `defineComponent`, Options API; props from `defineProps` and `props`
- [x] Template usage (`<UserCard>`, `<user-card>`) becomes `RENDERS`
- [x] Global `app.component` registrations
- [x] Composables become `USES_HOOK`
- [x] `@click` / `v-on` handlers become `EntryPoint` (kind `dom-event`)
- [x] Vue Router route records become `Page` nodes

### Nuxt

- [x] `pages/` and `layouts/` become `Page` nodes; auto-imported components and composables resolve
- [x] `server/api` and `server/routes` become `Route` nodes
- [x] `useFetch`, `useAsyncData` and `$fetch` become `REQUESTS`

### Stores

- [x] `Store` label (name, library) with `READS_STORE` / `WRITES_STORE`; bump `SCHEMA_VERSION`
- [x] Pinia `defineStore` (options and setup stores)

### Acceptance criteria

- [x] Fixtures and golden coverage for each component style, Nuxt pages and server routes, and Pinia
- [x] A pinned Vue or Nuxt sample (candidate: a RealWorld Vue frontend) with hand labels in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 15: Svelte, SvelteKit and Astro ([#80](https://github.com/fatihserhatturan/concentrate/issues/80))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 11, Phase 13

**Goal:** The component, page, API and store graph for Svelte, SvelteKit and Astro applications.

Reuses the SFC splitter (Phase 10), `Component` and `RENDERS` (Phase 11), `Page` (Phase 12), `REQUESTS` (Phase 13) and `Store` (Phase 14).

### Svelte

- [x] Components from `.svelte` files and template usage become `RENDERS`; props from `export let` and `$props()`
- [x] `on:click` and `onclick` handlers become `EntryPoint` (kind `dom-event`)
- [x] Svelte stores (`writable`, `readable`, `derived`) and runes (`$state`) become `Store`

### SvelteKit

- [x] `+page` and `+layout` files become `Page` nodes, with route parameters
- [x] `+server.ts` handlers become `Route` nodes
- [x] `load` functions and form actions; `fetch` inside `load` becomes `REQUESTS`

### Astro

- [x] `src/pages` files become `Page` nodes; endpoint files become `Route` nodes
- [x] Components rendered from `.astro` templates, including islands (`client:*`) of other frameworks, become `RENDERS`

### Acceptance criteria

- [x] Fixtures and golden coverage for Svelte components and stores, SvelteKit routes and Astro pages and islands
- [x] A pinned Svelte or SvelteKit sample with hand labels in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 16: Angular ([#81](https://github.com/fatihserhatturan/concentrate/issues/81))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 11, Phase 13

**Goal:** The component, DI, routing and API graph for Angular applications.

Angular is decorator-based like NestJS. The decorator route graph (`createDecoratorRouteGraph` in `route-graph.ts`) and NestJS DI resolution (`resolution/injections.ts`) are reused where they fit.

### Components

- [x] `@Component` (module-based and standalone) becomes `Component`, with its selector and `@Input` / `input()` props
- [x] Template usage by selector (inline `template` and `templateUrl` files) becomes `RENDERS`
- [x] `(click)` bindings and `@HostListener` become `EntryPoint` (kind `dom-event`)

### Services and DI

- [x] `@Injectable` services and constructor or `inject()` injection, reusing the NestJS DI resolution
- [x] `@NgModule` declarations, imports and providers

### Routing and API

- [x] Angular Router `Routes` arrays (including lazy `loadComponent` / `loadChildren`) become `Page` nodes
- [x] `HttpClient` calls become `REQUESTS`

### Acceptance criteria

- [x] Fixtures and golden coverage for components, DI, routes and `HttpClient`
- [x] A pinned Angular sample (candidate: a RealWorld Angular frontend) with hand labels in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 17: State libraries and ecosystem measurement ([#82](https://github.com/fatihserhatturan/concentrate/issues/82))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 11, Phase 13, Phase 14

**Goal:** Cover the common React state libraries and measure what the frontend graph is worth to an agent.

Completes M8: React-side stores on the `Store` node from Phase 14, store-aware MCP tools, and frontend questions in the agent benchmark (#73).

### Stores

- [x] Redux Toolkit: `createSlice`, `configureStore`, `useSelector` and `dispatch` of slice actions
- [x] Zustand `create` stores and their selectors
- [x] Jotai atoms

### MCP

- [x] `list_stores`
- [x] `impact_of` follows store reads and writes

### Measurement

- [x] Frontend and full-stack questions in the agent benchmark: which component calls this endpoint, what a component change affects, which pages a store reaches
- [x] Accuracy report section for each M8 relation type
- [x] README "What it sees" table and languages line cover the frontend

### Acceptance criteria

- [x] Fixtures and golden coverage for each store library
- [x] Agent benchmark results with the frontend questions, per category, are committed and documented
- [x] README and `docs/accuracy.md` report the M8 coverage

## M9: Go ecosystem

Phases 18–21 give Go the depth the JS/TS graph has: resolved packages and calls, HTTP routes,
data access, config, outbound HTTP links and dependency injection, measured on pinned samples.

### Decisions (M9 and M11)

- **Still one runtime dependency.** The vendored `go.wasm` and `rust.wasm` are upgraded to current
  grammar releases through `npm run grammars:build`, with the golden diffs reviewed. No new npm
  dependencies.
- **One framework-neutral schema.** Go and Rust reuse `Route`, `EntryPoint`, `Table` / `DataModel`,
  `EnvVar` / `ConfigValue`, `Interface` / `Enum` / `TypeAlias` and the `REQUESTS`, `USES_ENV`,
  `ACCESSES_DATA`, `READS` / `WRITES` and `IMPLEMENTS` relationships; new properties only where
  needed. Each phase bumps `SCHEMA_VERSION`. MCP tools stay language-neutral.
- **A framework layer per language.** `src/integrations/frameworks/go/` and
  `src/integrations/frameworks/rust/`, with parse-time plugin hooks like `JsTsFrameworkPlugin` and
  post-parse contributors registered in `src/composition/default-registry.ts`.
- **Measured like M8.** Every framework phase adds a pinned sample with hand labels to
  `bench:accuracy`; precision stays at 100% and recall is reported. Go and Rust RealWorld (Conduit)
  backends share their API with the existing frontend samples, so frontend → backend `REQUESTS`
  links are measured end to end.
- **Order.** Go first, then Rust; in each milestone the language foundation, then routes, then
  data, config and HTTP clients, then measurement.

## Phase 18: Go language foundation (modules, packages, interfaces, call resolution) ([#162](https://github.com/fatihserhatturan/concentrate/issues/162))

**Milestone:** M9 – Go ecosystem
**Depends on:** Phase 3a ([#5](https://github.com/fatihserhatturan/concentrate/issues/5))

**Goal:** Give Go the structural depth JS/TS has, so the framework phases (19, 20) can build on resolved packages, calls and types.

Go gets files, imports, structs, functions, methods and calls today (`src/integrations/languages/go/`), but:
- `resolveGoImport` (`src/integrations/resolution/imports.ts`) reads only the `module` line of the root `go.mod` and resolves an import to the *first* `.go` file under the package path (it can pick a file of a subpackage).
- `pkg.Func()` never resolves: the receiver match in `src/core/scan/resolution/calls.ts` falls back to a JS `import * as X` regex (`extractImportAlias`); golden `go-import` has no `CALL_RESOLVES_TO` for `service.New`.
- No interfaces, type aliases, generics, package `var`/`const`, embedded structs or import aliases; `parameters` and `returnType` are always `null`.
- A file with a syntax error fails as a whole file; `_test.go` files are not classified as tests; `find_unused_exports` is limited to JS/TS (`src/adapters/mcp/analysis-tools/unused.ts:16`).

### Grammar

- [x] Upgrade the vendored `go.wasm` (tree-sitter-go 0.21.2) to the current release through `npm run grammars:build`; review the golden diffs
- [x] Partial graph plus a scan warning for files with `ERROR` nodes, as for JS/TS

### Modules and packages

- [x] `go.mod` per module (nested modules) and `go.work` workspaces; `replace` directives to local paths
- [x] A package is a directory: an import resolves to every file of the package, not the first match; `vendor/` is skipped
- [x] Import aliases, `_` and `.` imports

### Declarations

- [x] Interfaces as `Interface` nodes; implicit `IMPLEMENTS` from method sets (struct and pointer receivers)
- [x] Embedded structs and interfaces (promoted methods); type aliases and defined types as `TypeAlias`; generics (type parameters recorded)
- [x] Package-level `var` / `const` as `Variable` nodes; `parameters` and `returnType` on functions and methods

### Calls

- [x] `pkg.Func()` and `pkg.Type{}` / `pkg.NewX()` resolve through the import (alias or last path segment)
- [x] Method calls on typed receivers: variables declared with a struct type, `x := pkg.NewX()` return types, struct fields, interface values (to every implementation, marked)

### Entrypoints and tests

- [x] `func main` in `package main` and `func init` as `EntryPoint` nodes
- [x] `_test.go` files, `TestX` / `BenchmarkX` functions classified as tests

### MCP

- [x] `find_unused_exports` covers Go (capitalized names not used outside their package)

### Acceptance criteria

- [x] Fixtures with golden coverage: multi-module `go.work`, package with several files, interfaces with implementations, embedded structs, generics, a file with a syntax error
- [x] Cross-package call resolution has hand labels on a pinned Go sample (precision 100%, recall reported)
- [x] `docs/known-limitations.md` has a Go section

## Phase 19: Go HTTP routes and entrypoints (net/http, gin, echo, chi, fiber, gRPC, cobra) ([#163](https://github.com/fatihserhatturan/concentrate/issues/163))

**Milestone:** M9 – Go ecosystem
**Depends on:** Phase 18

**Goal:** List every HTTP route of a Go service with its full path, method, middleware and handler, and the other entrypoints (gRPC services, CLI commands).

There is no Go framework detection today: `list_routes`, `route_details` and `api_consumers` return nothing for Go projects. The `Route`, `EntryPoint`, `DECLARES_ROUTE`, `ROUTE_HANDLED_BY`, `MOUNTS_*` and `ROUTE_LIFECYCLE_STEP` schema is framework-neutral and is reused. Framework code goes into a new `src/integrations/frameworks/go/` layer with a parse-time plugin hook like `JsTsFrameworkPlugin` (`src/integrations/frameworks/js-ts/scanner.ts`) and post-parse contributors registered in `src/composition/default-registry.ts`.

### Framework layer

- [x] `src/integrations/frameworks/go/` with a Go parser plugin hook and route contributors; `Route.framework` names the router

### Routers

- [x] `net/http`: `http.HandleFunc` / `Handle`, `ServeMux`, Go 1.22 patterns (`"GET /items/{id}"`), `http.StripPrefix` mounts
- [x] gin: `r.GET/POST/…`, `Group`, `Use`, `Any`, `Handle`
- [x] echo: `e.GET/…`, `Group`, middleware
- [x] chi: `r.Get/…`, `Route`, `Mount`, `Group`, `With`
- [x] fiber: `app.Get/…`, `Group`, `Mount`
- [x] gorilla/mux: `HandleFunc(...).Methods(...)`, `PathPrefix(...).Subrouter()`

### Route structure

- [x] Full paths through groups, sub-routers and mounts across functions and files (router passed as a parameter or returned)
- [x] Middleware as `ROUTE_LIFECYCLE_STEP`, in order
- [x] Handlers: functions, closures, methods on handler structs (`h.GetUser`), handler factories returning `http.HandlerFunc`
- [x] Routes registered in loops or with computed paths are reported as dynamic, as for JS/TS (#153)

### Other entrypoints

- [x] gRPC: `pb.RegisterXServer(s, impl)` → `EntryPoint` (kind `grpc`) per service method of the implementation
- [x] cobra commands (`&cobra.Command{Use, Run/RunE}`) → `EntryPoint` (kind `cli`)

### Acceptance criteria

- [x] One fixture per router with golden coverage
- [x] A pinned Go sample with hand-labelled routes: precision 100%, recall reported in `bench:accuracy`
- [x] `list_routes`, `route_details` and `impact_of` answer on the Go sample; `docs/mcp-server.md` and `known-limitations.md` updated

## Phase 20: Go data access, config and outbound HTTP (database/sql, sqlx, gorm, sqlc, ent, viper, fx/wire) ([#164](https://github.com/fatihserhatturan/concentrate/issues/164))

**Milestone:** M9 – Go ecosystem
**Depends on:** Phase 19

**Goal:** Answer "which handler touches this table", "which env variables does this service read" and "which routes does this client call" for Go code.

`Table`, `DataModel`, `ACCESSES_DATA`, `READS` / `WRITES`, `EnvVar`, `ConfigValue`, `USES_ENV`, `DECLARES_ENV` and `REQUESTS` exist for JS/TS (`src/integrations/frameworks/js-ts/data-access.ts`, `env-config.ts`, `env-files.ts`, `http-clients.ts`) and are language-neutral in the schema. None of them is produced for Go.

### Data access

- [x] `database/sql` and sqlx: `Query`, `QueryRow`, `Exec`, `Get`, `Select` with literal SQL → `Table` with `READS` / `WRITES`
- [x] gorm: models from structs (`gorm` tags, `TableName()`), `db.Model(&X{})`, `Find`, `Create`, `Where`, `Save`, `Delete`; associations as `RELATES_TO`
- [x] sqlc: generated `Queries` methods linked to their SQL and tables
- [x] ent: schemas (`ent/schema`) as `DataModel`, client calls (`client.User.Query()`)

### Config and env

- [x] `os.Getenv`, `os.LookupEnv`, `os.ExpandEnv` → `USES_ENV`
- [x] viper: `viper.GetString("x")`, `BindEnv`, `AutomaticEnv` with prefixes → `ConfigValue` / `EnvVar`
- [x] Struct-tag config: caarlos0/env (`env:"PORT"`), kelseyhightower/envconfig
- [x] `.env` files declare variables for Go projects too (`list_env_config { unread }`)

### Outbound HTTP

- [x] `http.Get/Post`, `http.NewRequest(method, url)`, `client.Do`, resty → `REQUESTS` to project routes (same `--api-origin` rules as JS/TS)

### Dependency injection

- [x] uber fx: `fx.Provide` / `fx.Invoke` provider graph as `INJECTS`
- [x] google wire: `wire.Build` / `wire.NewSet` providers

### MCP

- [x] `list_data_access`, `list_tables`, `list_env_config` and `impact_of` cover Go

### Acceptance criteria

- [x] Fixtures with golden coverage for each library above
- [x] Hand labels for data access and env on the pinned Go sample: precision 100%, recall reported
- [x] Docs updated (`docs/known-limitations.md`, `docs/mcp-server.md`)

## Phase 21: Go ecosystem measurement (samples, accuracy, agent benchmark, README) ([#165](https://github.com/fatihserhatturan/concentrate/issues/165))

**Milestone:** M9 – Go ecosystem
**Depends on:** Phase 20

**Goal:** Prove the Go graph with the same measurements as M8: pinned samples, hand labels, the agent benchmark and README numbers.

`scripts/samples.json` has 13 samples, all JS/TS; `bench/labels/` has no Go labels; the agent question sets (`bench/agent/questions*.json`) have no Go questions. The RealWorld (Conduit) API is shared by the existing frontend samples, so a Go RealWorld backend lets frontend → Go backend `REQUESTS` be measured end to end.

### Samples and labels

- [x] Pin a Go RealWorld backend (gin) and one more Go service (chi or echo, with gorm or sqlx) in `scripts/samples.json` (#174, #183)
- [x] Hand labels for routes, cross-package calls, data access and env in `bench/labels/` (#174, #183)
- [x] Golden sample graphs where they stay small enough (#186)

### Accuracy and performance

- [x] Go rows in every `bench:accuracy` section; precision 100%, recall reported (#174, #183)
- [x] Scan time and memory for the Go samples in `docs/benchmarks.md` (#184)

### Agent benchmark

- [x] Go questions (routes, callers, impact, table users, env, frontend → Go backend) in the agent benchmark; results per category committed and documented (cost estimate and approval before paid runs) (#185)

### Docs

- [x] README "What it sees" table and languages line cover Go (#175–#183)
- [x] `docs/accuracy.md` and `docs/known-limitations.md` updated (#183)

### Acceptance criteria

- [x] Accuracy, performance and agent results for Go are reproducible from scripts (#183–#185)
- [x] README shows the Go coverage (#183)

## M10: Non-code files

Phases 22–25 bring the rest of a project into the graph: every file as a `File` node, the non-code
formats parsed with vendored tree-sitter grammars (Dockerfile and `.proto` with small line readers,
as they have no usable npm grammar), scripts and infrastructure as entrypoints with the env they read
and set, styles linked to the components that use them, and SQL tables and `.proto` services linked
to the code. They come before M11 (Rust) so the Rust phases find these files already in the graph.

## Phase 22: Every file in the graph (grammars, file nodes, asset imports) ([#202](https://github.com/fatihserhatturan/concentrate/issues/202))

**Milestone:** M10 – Non-code files
**Depends on:** Phase 21

**Goal:** Make every file of a project a `File` node, parse the non-code formats with vendored tree-sitter grammars, and resolve imports of styles, JSON and assets, so Phases 23–25 can build on them.

- Only code files become `File` nodes: `detectLanguage` (`src/core/scan/language.ts`) maps TS/JS, HTML, Vue, Svelte, Astro, Python, Go and Rust; every other file is discovered and counted as skipped (`discoveredFiles − supportedFiles`).
- A few non-code files are read for one fact each: `package.json`, `tsconfig.json` / `jsconfig.json`, `pnpm-workspace.yaml`, `.env*`, `schema.prisma`, `go.mod`.
- `import "./x.css"`, `import data from "./x.json"` and image imports count as unresolved relative imports (`src/integrations/resolution/imports.ts`).
- The pinned samples have 391 `.json`, 200 `.md`, 140 `.yml`/`.yaml`, 51 `.css`, 56 `.proto`, 32 `.sql`, 24 `.sh`, 15 `Dockerfile` and 14 `Makefile` files the graph does not show.

### Grammars

- [ ] Add to `scripts/build-grammars.mjs` and `GrammarName` (`src/integrations/languages/syntax/tree-sitter.ts`): `tree-sitter-css`, `tree-sitter-scss` (CSS grammar with a warning if it does not build with the pinned CLI), `tree-sitter-json`, `@tree-sitter-grammars/tree-sitter-yaml`, `tree-sitter-bash`, `tree-sitter-powershell` (a release at least two weeks old), `tree-sitter-make`, `@derekstride/tree-sitter-sql`; record the bytes added to `vendor/grammars`
- [ ] Dockerfile and `.proto` get small line readers (no usable npm grammar; `tree-sitter-dockerfile` on npm is a security placeholder and must not be used)

### Files

- [ ] `detectLanguage` gains `css`, `scss`, `less`, `json`, `yaml`, `shell`, `powershell`, `dockerfile`, `makefile`, `sql`, `proto`, `markdown`, `toml`; any other discovered file is a `File` node with language `other` (text) or `asset` (binary)
- [ ] Lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock`) and files above a size limit are nodes but are not parsed; lockfiles are `generated`
- [ ] A `docs` source type for Markdown, `LICENSE` and `docs/` files (`src/core/scan/file-classification.ts`)
- [ ] A file with syntax errors keeps a partial graph and gets a scan warning

### Imports

- [ ] JS/TS imports of `.css`, `.scss`, `.less`, `.json`, `.svg` and images, and `new URL("./x", import.meta.url)`, resolve to the `File` (`RESOLVES_TO`)
- [ ] HTML `<link href>` and `<script src>` resolve the same way

### Report and store

- [ ] The scan report and smoke counts split code files from other files; smoke expectations updated for every sample
- [ ] `SCHEMA_VERSION` bumped; the parse cache follows the code fingerprint (`src/composition/parser-fingerprint.ts`)

### MCP

- [ ] File rows carry `language` and `sourceType`; searches can filter by them. The tool list stays under 19 000 characters (`tests/mcp-protocol.test.ts`, 18 982 today): new output goes into existing tools and descriptions are trimmed to make room

### Acceptance criteria

- [ ] Fixtures with golden coverage: a repo with every listed format, asset imports from JS/TS and HTML, a lockfile and a file with a syntax error
- [ ] Unresolved relative imports drop on the pinned JS/TS samples; the remaining ones are listed in the PR
- [ ] `docs/known-limitations.md` has a non-code files section

## Phase 23: Scripts and infrastructure (shell, PowerShell, Docker, Make, npm scripts, compose, CI) ([#203](https://github.com/fatihserhatturan/concentrate/issues/203))

**Milestone:** M10 – Non-code files
**Depends on:** Phase 22

**Goal:** Show what a project's scripts and infrastructure run and which env they read or set, so an agent can answer "which script starts the server" or "which variables does CI set" from the graph.

- Shell and PowerShell scripts, Dockerfiles, Makefiles, `package.json` scripts, docker-compose files and CI workflows are not in the graph (Phase 22 makes them `File` nodes).
- Env reads come only from code (`process.env`, `os.Getenv`, struct tags…) and `.env*` files declare variables; variables set by Docker, compose or CI count as undeclared in `list_env_config`.

### Entrypoints

- [ ] `EntryPoint` nodes for a script file (`script`), a Makefile target (`make`), a `package.json` script (`npm-script`), a compose service (`compose-service`), a CI job (`ci-job`) and a Dockerfile `CMD` / `ENTRYPOINT` (`docker`)
- [ ] `RUNS` from an entrypoint to the project file or entrypoint it starts: `node dist/index.js`, `tsx scripts/x.ts`, `go run ./cmd/server`, `python manage.py`, `./scripts/deploy.sh`, `npm run build`, `make test`, compose `build:` → its Dockerfile

### Env

- [ ] Reads as `USES_ENV`: shell `$VAR` / `${VAR}` (not the script's own locals, positional or special parameters), PowerShell `$env:VAR`, compose `${VAR}`, workflow `${{ env.X }}` / `${{ secrets.X }}`
- [ ] Declarations (`export VAR=`, Dockerfile `ENV` / `ARG`, compose `environment:` / `env_file:`, workflow `env:`) count like `.env` declarations, so `list_env_config { unread }` and its undeclared check see them

### MCP

- [ ] `list_entrypoints` and `impact_of` include these entrypoints and `RUNS` ("what runs `cmd/server`", "what breaks if `scripts/build.ts` moves")

### Acceptance criteria

- [ ] Fixtures with golden coverage for each source (shell, PowerShell, Dockerfile, Makefile, npm scripts, compose, a GitHub Actions workflow)
- [ ] Hand labels for script entrypoints, `RUNS` and env declarations on two pinned samples (precision 100%, recall reported)

## Phase 24: CSS and SCSS (selectors, custom properties, CSS modules, class links) ([#204](https://github.com/fatihserhatturan/concentrate/issues/204))

**Milestone:** M10 – Non-code files
**Depends on:** Phase 23

**Goal:** Connect styles to the components and pages that use them, so the impact of changing a class or a custom property is answerable from the graph.

- CSS and SCSS files are not read; a component's `className` or `class` attribute is text in its template and links to nothing.

### Styles

- [x] Rules, class and id selectors and custom properties (`--x` definitions, `var(--x)` uses) as nodes of a style label, with file and line (#221)
- [x] `@import`, `@use`, `@forward` and `url()` as `Import` → `File` (#221)

### Links

- [x] CSS Modules: `import s from "./x.module.css"` with `s.btn` / `s["btn"]` links the function or component to the class (#222)
- [x] `className="btn"`, `class="btn"` and `:class` / `class:` bindings with literal names in JSX, Vue, Svelte, Angular and HTML templates link to same-named classes, marked as name matches (#222)

### MCP

- [x] `find_references` and `impact_of` on a class or a custom property return the components, pages and files that use it (#223)

### Acceptance criteria

- [x] Fixtures with golden coverage: plain CSS, SCSS with nesting and `@use`, CSS Modules in React and Vue, template class bindings (#221, #222)
- [x] Hand labels for CSS-module and template class links on two pinned frontend samples (precision 100%, recall reported) (#223)

## Phase 25: SQL migrations, .proto services and measurement ([#205](https://github.com/fatihserhatturan/concentrate/issues/205))

**Milestone:** M10 – Non-code files
**Depends on:** Phase 24

**Goal:** Read database schemas from SQL files and service contracts from `.proto` files, link them to the code that uses them, and measure the milestone on the pinned samples.

- `Table` nodes come from code (ORM models, query strings, Prisma, sqlc) but not from SQL migrations or `schema.sql`.
- `.proto` files are not read; gRPC is linked only through the generated Go code (`src/integrations/frameworks/go/grpc.ts`, #201).

### SQL

- [x] `CREATE TABLE`, `ALTER TABLE … ADD COLUMN`, `CREATE VIEW` and `CREATE INDEX` in migrations and schema files as `Table` nodes with columns, merged by name with the tables found from code; migration order recorded (#224)

### Protobuf

- [x] `package`, `service`, `rpc` and `message` read from `.proto` files; an rpc links to the generated Go server interface method and its implementations through the `pkg.Svc` service name (#225, #226)

### Measurement

- [x] Smoke counts and golden graphs updated for every sample (#216–#226)
- [x] Hand labels on pinned samples for SQL tables and `.proto` rpcs (#226)
- [x] Agent benchmark questions on non-code files (CI and compose env, which script runs what, CSS class impact, migration tables); paid runs only after a cost estimate and approval (questions in #226; the paid run was declined, not run)
- [x] README and `docs/known-limitations.md` describe the non-code file support (#224–#226)

### Acceptance criteria

- [x] Fixtures with golden coverage: migrations that create and alter tables, a `.proto` with two services linked to generated Go code (#224, #225)
- [x] Every M10 label scores 100% precision; recall reported (#226)


## M11: Rust ecosystem

Phases 26–29 do the same for Rust: Cargo workspaces, path calls, traits and attributes, then axum,
actix-web, Rocket and warp routes, sqlx, diesel and SeaORM data access, config and reqwest links.
The decisions of M9 apply.

## Phase 26: Rust language foundation (Cargo workspaces, paths, traits, enums, attributes) ([#166](https://github.com/fatihserhatturan/concentrate/issues/166))

**Milestone:** M11 – Rust ecosystem
**Depends on:** Phase 25

**Goal:** Give Rust the structural depth JS/TS has, so the framework phases (27, 28) can build on resolved crates, paths, calls, traits and attributes.

Rust gets files, `use` / `mod` imports, structs, functions, impl methods, calls and macro invocations today (`src/integrations/languages/rust/`), but:
- There is no `Cargo.toml` or workspace handling; `use` of another crate of the workspace and external crates are skipped (`resolveRustImport`).
- `a::b()` and `Type::method()` paths are never split (`analyzeMemberCallExpression` in `src/core/scan/resolution/calls.ts` splits on `.` only), so most Rust calls do not resolve.
- No traits, `impl Trait for X`, enums, generics, `const` / `static`, or attributes (`#[get]`, `#[derive]`, `#[tokio::main]`); `parameters` and `returnType` are always `null`.
- A file with a syntax error fails as a whole file; `#[cfg(test)]` modules and `tests/` are not classified as tests; `find_unused_exports` is limited to JS/TS.

### Grammar

- [x] Upgrade the vendored `rust.wasm` (tree-sitter-rust 0.21.0 → 0.24.0) to the current release through `npm run grammars:build`; review the golden diffs
- [x] Partial graph plus a scan warning for files with `ERROR` nodes

### Crates and modules

- [x] `Cargo.toml` packages and `[workspace]` members; crate names (with `-` → `_`) in `use` resolve to the crate's `lib.rs` / `main.rs`
- [x] `mod` trees (`mod.rs`, `foo.rs` + `foo/`, `#[path]`), `pub use` re-exports, `use` groups, aliases and globs

### Declarations

- [x] Traits as `Interface` nodes, `impl Trait for X` as `IMPLEMENTS`; trait default methods
- [x] Enums (`Enum`), type aliases, generics (type parameters recorded), `const` / `static` as `Variable`
- [x] Attributes as `Decorator` nodes (name and arguments), `#[derive(...)]` recorded
- [x] `macro_rules!` definitions; `parameters` and `returnType` on functions and methods

### Calls

- [x] Path calls `module::func()`, `Type::new()`, `Type::method()` and `Trait::method()` resolve through `use` and the module tree
- [x] Method calls on typed receivers (`let x: T`, `T::new()` return types, `self` fields); trait method calls to every implementation, marked

### Entrypoints and tests

- [x] `fn main`, `#[tokio::main]`, `#[actix_web::main]` as `EntryPoint` nodes
- [x] `#[test]`, `#[tokio::test]`, `#[cfg(test)]` modules and `tests/` classified as tests

### MCP

- [x] `find_unused_exports` covers Rust (`pub` items not used outside their crate)

### Acceptance criteria

- [x] Fixtures with golden coverage: Cargo workspace with two crates, nested `mod` trees, traits with implementations, enums, attributes, a file with a syntax error
- [x] Path call resolution has hand labels on a pinned Rust sample (precision 100%, recall reported)
- [x] `docs/known-limitations.md` has a Rust section

## Phase 27: Rust HTTP routes and entrypoints (axum, actix-web, Rocket, warp, tonic, clap) ([#167](https://github.com/fatihserhatturan/concentrate/issues/167))

**Milestone:** M11 – Rust ecosystem
**Depends on:** Phase 26

**Goal:** List every HTTP route of a Rust service with its full path, method, middleware and handler, and the other entrypoints (gRPC services, CLI commands).

There is no Rust framework detection today. The framework-neutral `Route` / `EntryPoint` schema is reused, and framework code goes into a new `src/integrations/frameworks/rust/` layer (parse-time plugin hook plus post-parse contributors), like the Go layer of Phase 19. Attribute routes need the `Decorator` nodes of Phase 26.

### Framework layer

- [x] `src/integrations/frameworks/rust/` with a Rust parser plugin hook and route contributors; `Route.framework` names the framework

### Routers

- [x] axum: `Router::new().route("/x", get(h).post(h2))`, `nest`, `merge`, `route_service`, `layer` / `route_layer`, `with_state`
- [x] actix-web: `#[get("/x")]` and the other method attributes, `App::new().service(...)`, `web::resource().route()`, `web::scope`, `configure`
- [x] Rocket: `#[get("/x")]` attributes, `routes![...]`, `rocket::build().mount("/base", routes)`
- [x] warp: `warp::path!` and filter chains (`and`, `or`, `get()`)

### Route structure

- [x] Full paths through nested routers and scopes across functions, modules and crates
- [x] Middleware / layers / guards as `ROUTE_LIFECYCLE_STEP`; extractors (`Path`, `Query`, `Json`, `State`) recorded on the route
- [x] Routes built in loops or from computed paths are reported as dynamic, as for JS/TS (#153)

### Other entrypoints

- [x] tonic: `XServer::new(impl)` → `EntryPoint` (kind `grpc`) per trait method of the implementation
- [x] clap: `#[derive(Parser)]` / `Subcommand` enums and builder `Command::new` → `EntryPoint` (kind `cli`)

### Acceptance criteria

- [x] One fixture per framework with golden coverage
- [x] A pinned Rust sample with hand-labelled routes: precision 100%, recall reported in `bench:accuracy`
- [x] `list_routes`, `route_details` and `impact_of` answer on the Rust sample; docs updated

## Phase 28: Rust data access, config and outbound HTTP (sqlx, diesel, SeaORM, env, reqwest) ([#168](https://github.com/fatihserhatturan/concentrate/issues/168))

**Milestone:** M11 – Rust ecosystem
**Depends on:** Phase 27

**Goal:** Answer "which handler touches this table", "which env variables does this service read" and "which routes does this client call" for Rust code.

The data, env and HTTP-client relationships (`Table`, `DataModel`, `READS` / `WRITES`, `EnvVar`, `ConfigValue`, `USES_ENV`, `DECLARES_ENV`, `REQUESTS`) are language-neutral in the schema but produced only for JS/TS (and Go after Phase 20).

### Data access

- [x] sqlx: `query!`, `query_as!`, `query_scalar!` and `sqlx::query(...)` with literal SQL → `Table` with `READS` / `WRITES`; `#[derive(FromRow)]` structs as `DataModel`
- [x] diesel: `table!` macros (`schema.rs`) as `Table`, `#[derive(Queryable, Insertable)]` + `#[diesel(table_name)]` models, query DSL (`users::table.filter(...)`, `insert_into`, `update`, `delete`)
- [x] SeaORM: `DeriveEntityModel` entities with `table_name`, `Entity::find()`, `ActiveModel` inserts / updates; relations as `RELATES_TO`

### Config and env

- [x] `std::env::var`, `env::var_os`, `env!` / `option_env!` → `USES_ENV`
- [x] dotenvy / dotenv loading; `.env` files declare variables for Rust projects too
- [x] The `config` crate (`Config::builder().add_source(Environment::with_prefix(...))`, `get_string`), envy, and clap `#[arg(env = "X")]` → `ConfigValue` / `EnvVar`

### Outbound HTTP

- [x] reqwest (`reqwest::get`, `Client::get/post/request`, `.send()`) → `REQUESTS` to project routes, with the `--api-origin` rules

### MCP

- [x] `list_data_access`, `list_tables`, `list_env_config` and `impact_of` cover Rust

### Acceptance criteria

- [x] Fixtures with golden coverage for each library above
- [x] Hand labels for data access and env on the pinned Rust sample: precision 100%, recall reported
- [x] Docs updated (`docs/known-limitations.md`, `docs/mcp-server.md`)

## Phase 29: Rust ecosystem measurement (samples, accuracy, agent benchmark, README) ([#169](https://github.com/fatihserhatturan/concentrate/issues/169))

**Milestone:** M11 – Rust ecosystem
**Depends on:** Phase 28

**Goal:** Prove the Rust graph with the same measurements as M8 and M9: pinned samples, hand labels, the agent benchmark and README numbers.

There are no Rust samples, labels or agent questions today. A Rust RealWorld (Conduit) backend shares its API with the existing frontend samples, so frontend → Rust backend `REQUESTS` can be measured end to end.

### Samples and labels

- [x] Pin a Rust RealWorld backend (axum + sqlx) and one more Rust service (actix-web with diesel or SeaORM) in `scripts/samples.json`
- [x] Hand labels for routes, path calls, data access and env in `bench/labels/`
- [x] Golden sample graphs where they stay small enough

### Accuracy and performance

- [x] Rust rows in every `bench:accuracy` section; precision 100%, recall reported
- [x] Scan time and memory for the Rust samples in `docs/benchmarks.md`

### Agent benchmark

- [x] Rust questions (routes, callers, impact, table users, env, trait implementations, frontend → Rust backend) in the agent benchmark; results per category committed and documented (cost estimate and approval before paid runs)

### Docs

- [x] README "What it sees" table and languages line cover Rust
- [x] `docs/accuracy.md` and `docs/known-limitations.md` updated

### Acceptance criteria

- [x] Accuracy, performance and agent results for Rust are reproducible from scripts
- [x] README shows the Rust coverage

## M12: Python ecosystem

Phases 30–33 bring Python from imports and plain calls to the depth of Go and Rust:
packages, classes, decorators and typed method calls, then Django, Flask and FastAPI routes, SQLAlchemy
and Django ORM data access, config, HTTP clients and dependency injection. The decisions of M9 apply.

## Phase 30: Python language foundation (packages, classes, decorators, type hints, tests) ([#207](https://github.com/fatihserhatturan/concentrate/issues/207))

**Milestone:** M12 – Python ecosystem
**Depends on:** Phase 29

**Goal:** Resolve Python packages, classes and calls as well as Go and Rust, so Phases 31–33 can attach routes, data access and config to real call targets.

- `src/integrations/languages/python/parser.ts` makes `File`, `Import`, `Function`, `Class` and `Call` nodes only; module imports resolve through `src/core/scan/resolution/import-candidates.ts` (`.py`, `__init__.py`).
- The grammar is pinned to `tree-sitter-python` 0.21.0 (`scripts/build-grammars.mjs`; upgraded to 0.25.0 in part 1).
- There are no decorators, type hints, base classes, method receivers, entrypoints or test classification, and a file with a syntax error is not partial.

### Grammar

- [x] Upgrade `tree-sitter-python` to 0.25.0 with reviewed golden diffs
- [x] A file with `ERROR` nodes keeps a partial graph and gets a scan warning

### Packages and imports

- [x] Packages from `pyproject.toml` (`[project]`, Poetry, setuptools), `setup.py` / `setup.cfg`, including the `src/` layout, as `Package` nodes
- [x] `__init__.py` re-exports and `__all__`; relative imports (`from ..x import y`); `import a.b as c` and `from x import *`

### Declarations

- [x] Classes with their bases (`EXTENDS`); `Protocol` and `abc.ABC` classes as interfaces with `IMPLEMENTS` for structural or declared implementations
- [x] Decorators as `Decorator` nodes (`DECORATED_BY`), as for TypeScript
- [x] `parameters` and `returnType` from type hints; module-level variables and constants as `Variable` nodes
- [x] Fields of `dataclass`, `NamedTuple`, `TypedDict`, `attrs` and pydantic models

### Calls

- [x] Module functions through imports and aliases; `self.method()` and `cls.method()`; `super().method()`
- [x] Methods on typed receivers (annotated parameters and variables, constructor results, return types)
- [x] A call through a base class reaches the overrides, marked as such

### Entrypoints and tests

- [x] `if __name__ == "__main__":` blocks and `[project.scripts]` / `console_scripts` as `EntryPoint` nodes
- [x] pytest (`test_*.py`, `*_test.py`, `conftest.py`, fixtures) and unittest classified as tests

### MCP

- [x] `find_unused_exports` covers Python modules (`__all__` or public names)

### Acceptance criteria

- [x] A Python fixture with a package, a base class, decorators and typed method calls has golden graphs
- [x] Calls to methods of typed receivers resolve; unresolved calls are counted, never guessed

## Phase 31: Python HTTP routes and entrypoints (Django, Flask, FastAPI, Celery, click/typer) ([#208](https://github.com/fatihserhatturan/concentrate/issues/208))

**Milestone:** M12 – Python ecosystem
**Depends on:** Phase 30

**Goal:** Find the HTTP routes and other entrypoints of Python services with full paths and their handlers, so routes, callers and impact work for Python backends.

- Routes are written by the framework layer (`src/integrations/frameworks/`), as for Express, NestJS and the Go frameworks; there are no Python frameworks yet.
- Prefixes compose across files (Django `include`, Flask blueprints, FastAPI `include_router`), as for Go routers.

### Django

- [x] `urls.py` `path`, `re_path` and `include` (including `include("app.urls")` strings) with full paths
- [x] Function views and class-based views; `as_view()` maps HTTP methods to the view's methods
- [x] Django REST framework routers (`DefaultRouter.register`) and ViewSet actions (`@action`)
- [x] `MIDDLEWARE` in settings as lifecycle steps

### Flask

- [x] `@app.route` / `@app.get` and friends with `methods`
- [x] `Blueprint(url_prefix=…)` and `register_blueprint(url_prefix=…)`; `before_request` / `after_request` as lifecycle steps

### FastAPI and Starlette

- [x] `@app.get` / `APIRouter(prefix=…)` / `include_router(prefix=…)`
- [x] `Depends(...)` in route signatures and `dependencies=[…]` as lifecycle steps
- [x] Starlette `Route` / `Mount` lists

### Other entrypoints

- [x] Celery `@shared_task` / `@app.task` and `.delay()` / `.apply_async()` calls linked to the task
- [x] click and typer commands; Django management commands (`BaseCommand.handle`)

### Acceptance criteria

- [x] Fixtures for Django, Flask and FastAPI have golden routes with full paths and handlers
- [x] `list_routes` and `find_route` answer for Python services

## Phase 32: Python data access, config, outbound HTTP and DI (SQLAlchemy, Django ORM, env, requests/httpx) ([#209](https://github.com/fatihserhatturan/concentrate/issues/209))

**Milestone:** M12 – Python ecosystem
**Depends on:** Phase 31

**Goal:** Link Python code to the tables it reads and writes, the env it uses, the HTTP services it calls and the dependencies it gets injected.

- M9 wrote `Table`, `USES_ENV`, `REQUESTS` and `INJECTS` for Go; M10 Phase 25 adds tables from SQL migrations. Python reuses the same nodes and relationships.

### Data access

- [x] SQLAlchemy models (`__tablename__`, `Column`, `Mapped[...]`) and queries (`session.query(M)`, `select(M)`, `session.add`)
- [x] Django ORM models (`Meta.db_table`) and `Model.objects` queries; reverse relations
- [x] DB-API `cursor.execute("…")` SQL (sqlite3, psycopg, asyncpg) mapped to tables
- [x] Alembic and Django migrations merged with the tables of M10

### Env and config

- [x] `os.environ[...]`, `os.environ.get`, `os.getenv` as `USES_ENV`
- [x] pydantic `BaseSettings` fields (with `env_prefix`), Django `settings.X`, python-dotenv, `environs` / `decouple`

### Outbound HTTP

- [x] requests, httpx and aiohttp calls as `REQUESTS`, linked to routes of the scan when the path matches

### Dependency injection

- [x] FastAPI `Depends` providers and dependency-injector containers as `INJECTS`

### Acceptance criteria

- [x] Fixtures for SQLAlchemy, Django ORM, env and HTTP clients have golden graphs
- [x] `find_table_usage`, `find_env_usage` and frontend → Python backend `REQUESTS` answer for the fixtures

## Phase 33: Python ecosystem measurement (samples, accuracy, agent benchmark, README) ([#210](https://github.com/fatihserhatturan/concentrate/issues/210))

**Milestone:** M12 – Python ecosystem
**Depends on:** Phase 32

**Goal:** Prove the Python graph with the same measurements as M8, M9 and M11: pinned samples, hand labels, the agent benchmark and README numbers.

- There are no Python samples, labels or agent questions today. Django, FastAPI and Flask RealWorld (Conduit) backends share their API with the existing frontend samples, so frontend → Python backend `REQUESTS` can be measured end to end.

### Samples and labels

- [x] Pin Django, FastAPI and Flask samples (RealWorld variants where available) in `scripts/samples.json`
- [x] Hand labels for routes, calls, data access and env in `bench/labels/`
- [x] Golden sample graphs where they stay small enough

### Accuracy and performance

- [x] Python rows in every `bench:accuracy` section; precision 100%, recall reported
- [x] Scan time and memory for the Python samples in `docs/benchmarks.md`

### Agent benchmark

- [x] Python questions (routes, callers, impact, table users, env, frontend → Python backend) in the agent benchmark; results per category committed and documented (cost estimate and approval before paid runs)

### Docs

- [x] README "What it sees" table and languages line cover Python
- [x] `docs/accuracy.md` and `docs/known-limitations.md` updated

### Acceptance criteria

- [x] Accuracy, performance and agent results for Python are reproducible from scripts
- [x] README shows the Python coverage

## M13: C/C++ ecosystem

Phases 34–37 add C and C++: vendored grammars, include resolution, headers linked to
definitions, namespaces, classes and virtual calls, then CMake, Make and `compile_commands.json` targets,
Drogon, Crow, Pistache and cpp-httplib routes, gRPC C++ services, Qt signals, SQL, env and libcurl links.
The preprocessor is not run: macros are read as calls. The decisions of M9 apply.

## Phase 34: C/C++ language foundation (includes, headers, namespaces, classes, templates, macros, tests) ([#211](https://github.com/fatihserhatturan/concentrate/issues/211))

**Milestone:** M13 – C/C++ ecosystem
**Depends on:** Phase 33

**Goal:** Add C and C++ as languages: vendored grammars, include resolution, declarations and call resolution, so Phases 35–37 can build on them.

- There is no C or C++ support today; `.c`, `.h` and `.cpp` files are skipped (M10 Phase 22 makes them `File` nodes without content).
- `tree-sitter-c` 0.24.1 and `tree-sitter-cpp` 0.23.4 are on npm and can be vendored with `scripts/build-grammars.mjs`.
- Headers declare and sources define, so a function has two places; the preprocessor is not run.

### Grammars and files

- [x] Vendor `tree-sitter-c` and `tree-sitter-cpp`; record the bytes added to `vendor/grammars`
- [x] Extensions `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx`, `.ipp`, `.inl`; a `.h` file uses the C++ grammar when the project has C++ sources
- [x] A file with `ERROR` nodes (often from macros) keeps a partial graph and gets a scan warning

### Includes

- [ ] `#include "…"` resolves relative to the file, then through the include paths of `compile_commands.json` (done) and CMake (`include_directories`, `target_include_directories`; the CMake reader is Phase 35)
- [x] `#include <…>` headers outside the scan are external imports

### Declarations

- [x] Functions, structs, unions, classes (bases, `virtual`, `override`), namespaces, enums, `typedef` / `using` aliases
- [x] Templates with their parameters recorded; `#define` macros as nodes
- [x] A declaration in a header is linked to its definition in a source file (`Foo::bar` out of class)

### Calls

- [x] Free and namespace-qualified functions (`ns::f`, `using namespace`, `using ns::f`)
- [x] Methods on typed receivers (`T x`, `T* p`, `T& r`, `auto x = T(...)`, `std::make_unique<T>`, `this`)
- [x] A virtual call reaches every override, marked as such; macro invocations recorded

### Entrypoints and tests

- [x] `main` as an `EntryPoint`
- [x] GoogleTest (`TEST`, `TEST_F`, `TEST_P`) and Catch2 (`TEST_CASE`, `SECTION`) files classified as tests

### MCP

- [x] `find_unused_exports` covers non-`static` functions and classes declared in headers

### Acceptance criteria

- [x] C and C++ fixtures with headers, namespaces, classes and virtual calls have golden graphs
- [x] Calls resolve from a source file through the header to the definition; unresolved calls are counted, never guessed

## Phase 35: C/C++ build systems (CMake, Make, compile_commands.json) ([#212](https://github.com/fatihserhatturan/concentrate/issues/212))

**Milestone:** M13 – C/C++ ecosystem
**Depends on:** Phase 34

**Goal:** Read the build files of C/C++ projects so the graph knows the targets, their sources, their links and the include paths Phase 34 needs.

- There is no CMake grammar on npm, so `CMakeLists.txt` gets a small line reader, as Dockerfile and `.proto` do in M10.
- M10 Phase 23 parses Makefiles with `tree-sitter-make` and adds `RUNS` from entrypoints to scripts.

### CMake

- [ ] `add_executable` / `add_library` targets with their sources; `target_link_libraries` between targets; `add_subdirectory`
- [ ] `include_directories` / `target_include_directories` and `target_compile_definitions` passed to include resolution
- [ ] Variables set with `set(...)` expanded in the arguments above; anything else counted as unresolved

### Targets in the graph

- [ ] Targets as `Package` nodes (`PACKAGE_CONTAINS_FILE`, `PACKAGE_IMPORTS_PACKAGE` from links)
- [ ] An executable target is an `EntryPoint` with `RUNS` to its `main`

### Make and compile_commands.json

- [ ] Makefile compile and link rules map targets to sources
- [ ] `compile_commands.json` per-file flags (`-I`, `-D`) used when present

### Acceptance criteria

- [ ] A CMake fixture with two libraries and an executable has golden targets, links and include resolution
- [ ] Moving include paths into CMake does not lose any resolved include of the Phase 34 fixtures

## Phase 36: C/C++ HTTP and RPC frameworks, data access, config and outbound HTTP (Drogon, Crow, gRPC, Qt, sqlite3, libcurl) ([#213](https://github.com/fatihserhatturan/concentrate/issues/213))

**Milestone:** M13 – C/C++ ecosystem
**Depends on:** Phase 35

**Goal:** Find the routes, RPC services, signal/slot links, tables, env and outbound HTTP of C/C++ services, reusing the nodes and relationships of M9.

- C++ web frameworks register routes with macros (`CROW_ROUTE`, Drogon `METHOD_ADD`) or method calls (cpp-httplib `svr.Get`); the macros are read as calls, not expanded.
- gRPC C++ generates `X::Service` base classes and `X::Stub` clients; `src/integrations/frameworks/go/grpc.ts` already links Go clients to servers.

### HTTP routes

- [ ] Drogon (`METHOD_ADD`, `PATH_ADD`, `ADD_METHOD_TO`, `app().registerHandler`)
- [ ] Crow (`CROW_ROUTE`, `CROW_BP_ROUTE`, blueprints with prefixes)
- [ ] Pistache (`Routes::Get`, `Routes::bind`) and cpp-httplib (`svr.Get`, `svr.Post`)

### RPC and signals

- [ ] gRPC C++: a subclass of `X::Service` is an `EntryPoint` per method; `stub->Method(...)` calls link to the implementations (`via: "grpc"`)
- [ ] Qt `connect(sender, &A::signal, receiver, &B::slot)` links signal to slot

### Data and config

- [ ] SQL strings in sqlite3 (`sqlite3_exec`, `sqlite3_prepare_v2`), libpq (`PQexec`, `PQexecParams`) and SOCI calls mapped to tables
- [ ] `getenv`, `std::getenv` and `secure_getenv` as `USES_ENV`

### Outbound HTTP

- [ ] libcurl (`CURLOPT_URL`) and cpr (`cpr::Get`, `cpr::Post`) calls as `REQUESTS`

### Acceptance criteria

- [ ] Fixtures for Drogon or Crow, cpp-httplib, gRPC C++, Qt, sqlite3 and libcurl have golden graphs
- [ ] `list_routes`, `find_table_usage` and `find_env_usage` answer for C/C++ services

## Phase 37: C/C++ ecosystem measurement (samples, accuracy, agent benchmark, README) ([#214](https://github.com/fatihserhatturan/concentrate/issues/214))

**Milestone:** M13 – C/C++ ecosystem
**Depends on:** Phase 36

**Goal:** Prove the C/C++ graph with the same measurements as the other ecosystems: pinned samples, hand labels, the agent benchmark and README numbers.

- There are no C/C++ samples, labels or agent questions today.

### Samples and labels

- [ ] Pin a CMake C++ HTTP service (Drogon or Crow), a C library and a gRPC C++ sample in `scripts/samples.json`
- [ ] Hand labels for routes, calls, includes, data access and env in `bench/labels/`
- [ ] Golden sample graphs where they stay small enough

### Accuracy and performance

- [ ] C/C++ rows in every `bench:accuracy` section; precision 100%, recall reported
- [ ] Scan time and memory for the C/C++ samples in `docs/benchmarks.md`

### Agent benchmark

- [ ] C/C++ questions (routes, callers, impact, header → definition, build targets, env) in the agent benchmark; results per category committed and documented (cost estimate and approval before paid runs)

### Docs

- [ ] README "What it sees" table and languages line cover C and C++
- [ ] `docs/accuracy.md` and `docs/known-limitations.md` updated

### Acceptance criteria

- [ ] Accuracy, performance and agent results for C/C++ are reproducible from scripts
- [ ] README shows the C/C++ coverage

## Verification (every milestone)

- `npm run typecheck`, `npm test` (golden, parity and guardrail tests) and `npm run build`
- `node scripts/fetch-samples.mjs`, then `npm run smoke:samples -- --suite standing`
- MCP end to end: send `tools/list` and one call per tool over stdio to `npm run dev -- mcp`
- `npm ls --omit=dev` is empty; `npm pack` + `npx ./concentrate-*.tgz scan` works without native builds
