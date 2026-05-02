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
| `src/core/contracts/` | `src/graph/model`, `src/scanner/report`, `src/scanner/build-code-graph-types`, each other | `src/integrations/`, `src/parsers/languages/`, `src/graph/kuzu*`, `src/adapters/` |
| `src/integrations/languages/` | `src/core/`, `src/parsers/`, `src/graph/model` | `src/integrations/frameworks/`, `src/commands/` |
| `src/integrations/frameworks/` | `src/core/`, `src/integrations/languages/`, `src/parsers/`, `src/graph/model` | `src/commands/`, `src/adapters/` |
| `src/core/adapters/` | anything — this is the wiring layer | — |
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

Implemented directories after tasks 87 through 94:

```text
src/core/
  contracts/
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
  kuzu/
  mcp/
```

Remaining compatibility shims:

- Core contracts still reuse `src/graph/model`, `src/scanner/report`, and
  `src/scanner/build-code-graph-types` until graph/report types move into the
  core package.
- `src/core/adapters/` wraps the existing scanner pipeline instead of owning a
  fully independent core orchestrator.
- CLI/export/smoke/MCP commands now enter through core/platform adapters where
  practical, but command implementations still import report, schema, parse
  plan, and retry internals for existing public output compatibility.

Follow-up cleanup tasks:

- Move stable graph/report/result DTOs into `src/core/` once the adapter
  contracts settle.
- Split framework parse-time modules further where shared HTTP route detection
  becomes too broad for framework-specific behavior.
- Add first-class CLI/export adapters if command output compatibility no
  longer needs direct scanner/report imports.

## Next Phase: Core Independence

The next migration phase keeps the shell architecture in place while moving
stable ownership into the core. The intended order is:

1. Publish core-owned graph DTO exports, then migrate contracts/integrations to
   those exports.
2. Publish core-owned scan report/result DTO exports and preserve existing JSON
   shapes through compatibility aliases.
3. Move high-level scan orchestration into `src/core/scan/`, delegating legacy
   helpers until each helper has a safe home.
4. Let command and platform adapters call the core service instead of scanner
   internals.
5. Tighten guardrails so the temporary core-to-scanner/graph allowances shrink
   as each alias is removed.

This phase should not change graph schema, CLI behavior, smoke report shape, or
MCP tool output except where a task explicitly documents an intentional semantic
count improvement.

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
