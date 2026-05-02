# Known Limitations and Semantic Review Backlog

This backlog captures known risk areas before long-term architectural work
begins. It is intentionally practical: each item should either guide semantic
review or feed a future long-term task.

## Import Resolution

- Package and workspace resolution covers common npm, pnpm, yarn, `exports`,
  `main`, `types`, `baseUrl`, and `paths` cases, but does not yet model every
  conditional export branch or runtime-specific resolver rule.
- Dynamic imports with non-literal specifiers are represented as imports only
  when a literal source is visible.
- Cross-language imports are not semantically resolved beyond the language
  families already supported.

Blocks or informs: incremental scanning invalidation, MCP `find_definitions`,
and deeper package graph queries.

## Routes

- Express, Koa, Fastify, and NestJS route extraction covers common call and
  decorator patterns, but complex wrapper functions and framework-specific
  plugins can still hide route definitions.
- Full path resolution depends on visible mount chains and constant strings.
  Highly dynamic path construction can remain unresolved.
- Middleware ordering is structural, not a full runtime execution model.

Blocks or informs: semantic sample review reports and MCP route inspection
tools.

## Entrypoints

- Event, queue, cron, realtime, and Nest scheduler entrypoints are detected for
  common APIs, but custom wrapper libraries may appear as ordinary calls.
- Inline handlers are represented with synthetic function names; these are
  useful for graph queries but may need friendlier presentation in future UI or
  MCP responses.

Blocks or informs: MCP `list_entrypoints` and future backend runtime summaries.

## Config and Environment

- Environment and config links cover direct `process.env` access and visible
  local config exports. Complex schema validators or config factories may need
  additional resolver logic.
- Project config parsing is warning-tolerant, but warnings are diagnostic only;
  they do not yet influence confidence scores in semantic samples.

Blocks or informs: semantic confidence reporting and production-readiness
audits.

## Data Access

- Prisma, TypeORM, Mongoose, Sequelize, and Knex patterns are recognized when
  model, repository, client, or table names are visible in source.
- Data-access propagation follows resolved calls, injection fields, and
  repository/service methods, but complex factory containers or runtime DI
  registration can still hide relationships.
- Current false-positive guards avoid broad framework factories, but review
  findings from `semanticSamples.dataAccess` should be fed back into resolver
  rules.

Blocks or informs: deeper ORM-specific long-term work and MCP data lineage
queries.

## Workspace and Package Graph

- Workspace detection supports package manager metadata and common folder
  layouts. Non-standard monorepos may need explicit include/exclude patterns
  or future configuration.
- Package ownership is path based. Generated files outside package roots may be
  attached to the workspace root package.

Blocks or informs: incremental scanning package-level invalidation and package
filtered MCP queries.

## Kuzu Operations

- CLI `stats` and `query` retry transient lock errors by default, but Kuzu still
  allows one process per database path. Heavy parallel workflows should use
  separate database paths.
- Smoke validation serializes same-database operations. Ad hoc user scripts
  should follow the same rule unless they isolate database outputs.

Blocks or informs: future query server design and MCP concurrency behavior.

## Review Process

- Smoke reports include empty `falsePositiveFindings`,
  `falseNegativeFindings`, and `notes` arrays under `semanticSamples.review`.
  Manual review findings should be copied there first, then promoted into this
  backlog when they recur or affect large repositories.
- Before starting each long-term feature, run the release-readiness baseline
  and check whether any limitation above changes the feature design.
