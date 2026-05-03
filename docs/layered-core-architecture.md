# Layered Core Architecture

This document records the target architecture for separating Concentrate into a
stable platform/language-independent core, language integrations, and framework
semantics. The migration must preserve current behavior at every step.

## Goals

- Keep the main graph-building workload in a reusable core.
- Make language support pluggable without coupling the core to parser details.
- Make framework semantics sit above language integrations instead of being
  mixed into generic scanner code.
- Preserve all existing CLI, export, smoke, incremental, Kuzu, and MCP behavior
  during the migration.
- Let future integrations add languages or frameworks without broad core
  rewrites.

## Target Layers

### Core

The core is language, framework, and platform independent. It owns the shared
contracts and orchestration primitives.

Core responsibilities:

- Graph model types and graph builder primitives.
- Scan reports, warnings, failures, and validation-facing result types.
- File discovery, include/exclude handling, supported file descriptors, and
  generic classification contracts.
- Scan manifests, manifest diffs, parse plans, and incremental eligibility.
- Generic parser, resolver, and semantic contribution interfaces.
- Kuzu-independent graph write planning and graph patch concepts.
- Shared query/tool result shaping that does not depend on a specific language.

The core must not know about JavaScript, TypeScript, Python, Go, Rust, Express,
Fastify, NestJS, Prisma, TypeORM, or any other concrete language/framework.

### Language Integrations

Language integrations adapt concrete parser technology and language-specific
syntax into the core contracts.

Examples:

- JavaScript/TypeScript integration.
- Python integration.
- Go integration.
- Rust integration.

Language integration responsibilities:

- Register supported extensions and parser capabilities.
- Parse files into core graph nodes and relationships.
- Extract language-level imports, symbols, variables, calls, classes, methods,
  and type declarations.
- Provide language-specific import and call-resolution helpers.
- Report parser warnings/failures through core report contracts.

Language integrations should not own framework semantics such as Express routes,
Fastify plugins, NestJS modules, backend entrypoints, or data-access inference.

### Framework Semantics

Framework semantics sit above one or more language integrations. They consume
language-level graph output and add domain-specific relationships.

Examples for the current JavaScript/TypeScript stack:

- Express/Koa route semantics.
- Fastify route semantics.
- NestJS decorators, modules, injection, and scheduling.
- Backend entrypoints such as queues, cron, events, and realtime handlers.
- Env/config usage and consumption.
- Data-access model and operation inference.

Framework semantic modules should declare the language capabilities they require
and should be removable without breaking language-level parsing.

## Non-Goals

- Do not rewrite the scanner from scratch.
- Do not change graph schema names or relationship semantics unless a task
  explicitly migrates and validates them.
- Do not introduce a plugin package system before internal contracts are stable.
- Do not optimize parsing or graph writes as part of this refactor unless the
  task directly targets that behavior.

## Migration Strategy

Use a strangler-style migration. Add boundaries first, then move existing code
behind those boundaries in small slices.

1. Freeze current behavior with the release-readiness and smoke commands.
2. Introduce core contracts while existing modules still run through adapters.
3. Move scanner orchestration to core-facing abstractions.
4. Pilot the split with JavaScript/TypeScript because it has the richest
   language and framework surface.
5. Move JS/TS framework semantics out of parser/resolver internals and into a
   framework layer.
6. Move Python, Go, and Rust into language integration directories after the
   contracts prove stable.
7. Add architecture guardrails that prevent framework modules from importing
   core internals in the wrong direction.

## Guardrails

Every migration task must keep these checks green before moving on:

- `npm run typecheck`
- `npm test`
- `npm run build`
- Standing smoke validation for parser, resolver, graph, MCP, or Kuzu changes.
- Internet smoke validation for architecture, framework semantics, or
  large-repository performance changes.
- Incremental benchmark validation when manifest, parse plan, graph patching, or
  scanner orchestration changes.

The migration should prefer compatibility wrappers over large file moves when a
smaller step can preserve behavior and reduce review risk.

## Dependency Directions

Enforced by `tests/guardrails.test.ts`:

| Module | May import from | Must not import from |
| --- | --- | --- |
| `src/core/contracts/` | `src/core/graph`, `src/core/scan`, each other | `src/scanner/`, `src/graph/`, `src/integrations/`, `src/parsers/`, `src/adapters/`, `src/commands/` |
| `src/core/` | core modules, temporary scanner/parser/legacy graph shims where documented | `src/adapters/cli/`, `src/adapters/kuzu/`, `src/adapters/mcp/`, `src/commands/` |
| `src/integrations/languages/` | `src/core/`, `src/parsers/` | `src/integrations/frameworks/`, `src/commands/` |
| `src/integrations/frameworks/` | `src/core/`, `src/integrations/languages/`, `src/parsers/` | `src/commands/`, `src/adapters/` |
| `src/commands/` | `src/adapters/cli/` | `src/core/`, `src/scanner/`, `src/graph/`, `src/parsers/`, `src/integrations/` |
| `src/core/adapters/` | core compatibility wiring | platform adapters and commands |
| `src/adapters/` | anything — this is the platform adapter layer | — |

## Proposed Directory Shape

The exact file moves should happen gradually, but the target shape is:

```text
src/core/
  graph/
  scanner/
  incremental/
  contracts/

src/integrations/languages/
  js-ts/
  python/
  go/
  rust/

src/integrations/frameworks/
  js-ts/
    express-koa/
    fastify/
    nestjs/
    backend-entrypoints/
    env-config/
    data-access/

src/adapters/
  kuzu/
  cli/
  mcp/
```

Current directories may remain in place while compatibility wrappers are added.
The target shape is a destination, not a requirement for the first task.

## Current Migration Snapshot

Implemented directories after tasks 87 through 103:

```text
src/core/
  contracts/
  graph/
  integrations/
  scan/
  adapters/

src/integrations/languages/
  js-ts/
  python/
  go/
  rust/

src/integrations/frameworks/js-ts/
  backend-entrypoints.ts
  data-access.ts
  env-config.ts
  express-koa.ts
  fastify.ts
  nestjs.ts

src/adapters/
  cli/
  kuzu/
  mcp/
```

### Core-Owned Boundaries (tasks 95–103)

The following modules now live in `src/core/` and are the authoritative source.
Legacy `src/scanner/` and `src/graph/` paths are compatibility facades where
indicated.

| Core module | Canonical location | Legacy compat path |
| --- | --- | --- |
| Graph node/relationship model | `src/core/graph/model.ts` re-exports `src/graph/model.ts` | `src/graph/model.ts` (still canonical — direction not yet flipped) |
| File classification | `src/core/scan/file-classification.ts` | `src/scanner/file-classification.ts` ← compat facade |
| Parse plan | `src/core/scan/parse-plan.ts` | `src/scanner/parse-plan.ts` ← compat facade |
| Scan report / warnings | `src/core/scan/report.ts` | `src/scanner/report.ts` ← compat facade |
| BuildCodeGraph result/options | `src/core/scan/result.ts` | `src/scanner/build-code-graph-types.ts` ← compat facade |
| Scan manifest types | `src/core/scan/manifest.ts` re-exports `src/scanner/scan-manifest.ts` | `src/scanner/scan-manifest.ts` (FS-bound — not yet flipped) |
| Scan orchestrator | `src/core/scan/orchestrator.ts` | — |
| Integration registry | `src/core/integrations/` | — |

### Remaining Active Scanner Modules (not yet moved)

These scanner files still contain real implementations and have not been moved
to core. They remain in `src/scanner/` intentionally:

- `scan-manifest.ts` — filesystem I/O (readFile, stat, crypto); should move
  once a core I/O abstraction is introduced.
- `source-files.ts` — language detection for discovered files; tightly coupled
  to `scan-manifest.ts`.
- `build-code-graph.ts` — scan entry point; delegates to core orchestrator but
  handles Kuzu writes and report printing.
- `directory-graph.ts`, `discover-files.ts`, `concurrency.ts` — low-level
  filesystem and concurrency helpers.
- `graph-finalize.ts` — post-parse relationship resolution; calls the core
  integration registry.
- `parse-results.ts`, `parse-source.ts` — parse aggregation and dispatch.
- `project-config.ts`, `workspace-packages.ts` — project and monorepo config
  reading.
- `language.ts` — file extension to language mapping.
- `resolution/` — import, call, inheritance, and framework-specific resolvers.

### Compatibility Alias Cleanup Checklist

The following aliases exist to preserve backward compatibility while callers
migrate to core-owned paths. Remove each alias only after verifying that no
`src/` file imports the legacy path.

**Ready to clean up (compat facades pointing at core):**

1. `src/scanner/file-classification.ts`
   - Remove once all callers import from `src/core/scan/file-classification.js`.
   - Check: `grep -r "scanner/file-classification" src/`

2. `src/scanner/parse-plan.ts`
   - Remove once all callers import from `src/core/scan/parse-plan.js`.
   - Check: `grep -r "scanner/parse-plan" src/`

3. `src/scanner/report.ts`
   - Remove once all callers import from `src/core/scan/report.js`.
   - Check: `grep -r "scanner/report" src/`

4. `src/scanner/build-code-graph-types.ts`
   - Remove once all callers import from `src/core/scan/result.js`.
   - Check: `grep -r "scanner/build-code-graph-types" src/`

**Pending direction flip (core currently re-exports from legacy):**

5. `src/core/graph/model.ts` re-exports from `src/graph/model.ts`.
   - When ready: copy implementation to `src/core/graph/model.ts`, turn
     `src/graph/model.ts` into a compat facade re-exporting from core.
   - Prerequisite: verify all `src/graph/model` importers can tolerate the
     path change or update them to use `src/core/graph/model`.

6. `src/core/scan/manifest.ts` re-exports from `src/scanner/scan-manifest.ts`.
   - When ready: introduce a core I/O abstraction, move FS-bound logic behind
     it, then flip the direction as with the scan DTO files.

**Adapters and wiring shims:**

7. `src/core/adapters/` — compatibility re-exports kept for older wiring paths.
   - Remove once downstream callers use the direct core or platform adapter
     paths.

8. `src/core/scan/report.ts` and `src/core/scan/parse-plan.ts` import
   `createUncheckedIncrementalEligibility` and types from
   `src/scanner/scan-manifest.ts` as documented shims. Update to core paths
   when item 6 above is resolved.

9. `src/core/scan/parse-plan.ts` imports `SupportedSourceFile` from
   `src/scanner/source-files.ts` as a documented shim. Update when
   `source-files.ts` moves or its type is duplicated in core.

**Removing a compat alias — general steps:**
1. Run `grep -r "legacy/path" src/` and update each caller to the core path.
2. Delete the compat file.
3. Run `npm run typecheck && npm test && npm run build` to confirm no breakage.
4. Update this checklist.

## Core Independence Phase (tasks 95–103) — Completed

This phase moved stable ownership into the core while preserving all public
behavior. Each step is now complete:

1. Publish core-owned graph DTO exports and migrate contracts/integrations to
   those exports. **Complete — task 95.**
2. Publish core-owned scan report/result DTO exports and preserve existing JSON
   shapes through compatibility aliases. **Complete — task 96.**
3. Move high-level scan orchestration into `src/core/scan/`, delegating legacy
   helpers until each helper has a safe home. **Complete — task 97.**
4. Let command and platform adapters call the core service instead of scanner
   internals. Core parser/resolver/contributor registry ownership and command
   thinning. **Complete — tasks 98–99.**
5. Tighten guardrails so the temporary core-to-scanner/graph allowances shrink
   as each alias is removed. **Complete — task 100.**
6. Split shared JS/TS HTTP route semantics so Express/Koa and Fastify are wired
   through their own framework modules. **Complete — task 101.**
7. Move stable scanner helpers (file-classification, parse-plan, report,
   build-code-graph-types) into `src/core/scan/` and turn the legacy scanner
   paths into compatibility facades. **Complete — task 102.**
8. Document and deprecate compatibility aliases; add cleanup checklist.
   **Complete — task 103.**

This phase should not change graph schema, CLI behavior, smoke report shape, or
MCP tool output except where a task explicitly documents an intentional semantic
count improvement.

### Validation Run — Task 104 (2026-05-03)

All checks passed. Smoke counts are identical to the task 100 baseline —
tasks 101–103 introduced no regressions.

```
npm run typecheck   ✓
npm test            ✓  161/161 tests, 18 suites
npm run build       ✓
standing smoke      ✓  express, fastify, nestjs-starter, ky — all passed
incremental bench   ✓  7/7 repos passed; incremental write times 56–97 ms vs full 951–34,414 ms
MCP stdio smoke     ✓  2/2 tests passed
```

Standing smoke counts (schema version 34, unchanged from task 100 baseline):

| Sample | Parsed files | Nodes | Relationships | Routes |
| --- | --- | --- | --- | --- |
| express | 141 | 3281 | 4130 | 91 |
| fastify | 18 | 339 | 392 | 1 |
| nestjs-starter | 7 | 68 | 95 | 1 |
| ky | 52 | 5494 | 6926 | 0 |

Validation run for task 94:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run verify:rc`
- `npm run smoke:samples -- --suite internet --report .concentrate/smoke-internet-report.json --semantic-samples 5`
- `npm run benchmark:incremental`
- `npx tsx --test tests/mcp-tools.test.ts`

## Validation Matrix

| Migration area | Required checks |
| --- | --- |
| Core contracts only | typecheck, tests, build |
| Scanner orchestration | typecheck, tests, build, standing smoke |
| JS/TS language split | typecheck, tests, build, standing smoke |
| JS/TS framework split | typecheck, tests, build, standing smoke, internet smoke when backend semantics change |
| Other language splits | typecheck, tests, build, language parser tests |
| Kuzu or incremental boundaries | typecheck, tests, build, verify:rc, incremental benchmark |
| MCP adapter boundaries | typecheck, tests, build, MCP stdio smoke |

## Success Criteria

- Existing public CLI commands keep the same behavior.
- Existing graph schema remains compatible unless explicitly migrated.
- New language or framework integrations can be added through contracts without
  editing scanner orchestration.
- Framework modules can be tested independently from language parsers where
  practical.
- Core remains free of concrete language and framework imports.
