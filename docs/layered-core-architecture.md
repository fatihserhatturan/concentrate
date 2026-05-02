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
