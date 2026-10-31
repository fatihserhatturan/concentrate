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
  frontend (M8); Python, Go and Rust stay at least at today's level.

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

Order from here: the agent benchmark v2 ([#73](https://github.com/fatihserhatturan/concentrate/issues/73)), then M8, then
the M6 release (Phase 9).

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

- [ ] `Store` label (name, library) with `READS_STORE` / `WRITES_STORE`; bump `SCHEMA_VERSION`
- [ ] Pinia `defineStore` (options and setup stores)

### Acceptance criteria

- [ ] Fixtures and golden coverage for each component style, Nuxt pages and server routes, and Pinia
- [ ] A pinned Vue or Nuxt sample (candidate: a RealWorld Vue frontend) with hand labels in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 15: Svelte, SvelteKit and Astro ([#80](https://github.com/fatihserhatturan/concentrate/issues/80))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 11, Phase 13

**Goal:** The component, page, API and store graph for Svelte, SvelteKit and Astro applications.

Reuses the SFC splitter (Phase 10), `Component` and `RENDERS` (Phase 11), `Page` (Phase 12), `REQUESTS` (Phase 13) and `Store` (Phase 14).

### Svelte

- [ ] Components from `.svelte` files and template usage become `RENDERS`; props from `export let` and `$props()`
- [ ] `on:click` and `onclick` handlers become `EntryPoint` (kind `dom-event`)
- [ ] Svelte stores (`writable`, `readable`, `derived`) and runes (`$state`) become `Store`

### SvelteKit

- [ ] `+page` and `+layout` files become `Page` nodes, with route parameters
- [ ] `+server.ts` handlers become `Route` nodes
- [ ] `load` functions and form actions; `fetch` inside `load` becomes `REQUESTS`

### Astro

- [ ] `src/pages` files become `Page` nodes; endpoint files become `Route` nodes
- [ ] Components rendered from `.astro` templates, including islands (`client:*`) of other frameworks, become `RENDERS`

### Acceptance criteria

- [ ] Fixtures and golden coverage for Svelte components and stores, SvelteKit routes and Astro pages and islands
- [ ] A pinned Svelte or SvelteKit sample with hand labels in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 16: Angular ([#81](https://github.com/fatihserhatturan/concentrate/issues/81))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 11, Phase 13

**Goal:** The component, DI, routing and API graph for Angular applications.

Angular is decorator-based like NestJS. The decorator route graph (`createDecoratorRouteGraph` in `route-graph.ts`) and NestJS DI resolution (`resolution/injections.ts`) are reused where they fit.

### Components

- [ ] `@Component` (module-based and standalone) becomes `Component`, with its selector and `@Input` / `input()` props
- [ ] Template usage by selector (inline `template` and `templateUrl` files) becomes `RENDERS`
- [ ] `(click)` bindings and `@HostListener` become `EntryPoint` (kind `dom-event`)

### Services and DI

- [ ] `@Injectable` services and constructor or `inject()` injection, reusing the NestJS DI resolution
- [ ] `@NgModule` declarations, imports and providers

### Routing and API

- [ ] Angular Router `Routes` arrays (including lazy `loadComponent` / `loadChildren`) become `Page` nodes
- [ ] `HttpClient` calls become `REQUESTS`

### Acceptance criteria

- [ ] Fixtures and golden coverage for components, DI, routes and `HttpClient`
- [ ] A pinned Angular sample (candidate: a RealWorld Angular frontend) with hand labels in `bench:accuracy`
- [x] Precision stays at 100%; recall is reported

## Phase 17: State libraries and ecosystem measurement ([#82](https://github.com/fatihserhatturan/concentrate/issues/82))

**Milestone:** M8 – Full JS/TS ecosystem
**Depends on:** Phase 11, Phase 13, Phase 14

**Goal:** Cover the common React state libraries and measure what the frontend graph is worth to an agent.

Completes M8: React-side stores on the `Store` node from Phase 14, store-aware MCP tools, and frontend questions in the agent benchmark (#73).

### Stores

- [ ] Redux Toolkit: `createSlice`, `configureStore`, `useSelector` and `dispatch` of slice actions
- [ ] Zustand `create` stores and their selectors
- [ ] Jotai atoms

### MCP

- [ ] `list_stores`
- [ ] `impact_of` follows store reads and writes

### Measurement

- [ ] Frontend and full-stack questions in the agent benchmark: which component calls this endpoint, what a component change affects, which pages a store reaches
- [ ] Accuracy report section for each M8 relation type
- [ ] README "What it sees" table and languages line cover the frontend

### Acceptance criteria

- [ ] Fixtures and golden coverage for each store library
- [ ] Agent benchmark results with the frontend questions, per category, are committed and documented
- [ ] README and `docs/accuracy.md` report the M8 coverage

## Verification (every milestone)

- `npm run typecheck`, `npm test` (golden, parity and guardrail tests) and `npm run build`
- `node scripts/fetch-samples.mjs`, then `npm run smoke:samples -- --suite standing`
- MCP end to end: send `tools/list` and one call per tool over stdio to `npm run dev -- mcp`
- `npm ls --omit=dev` is empty; `npm pack` + `npx ./concentrate-*.tgz scan` works without native builds
