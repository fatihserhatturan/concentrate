# Release Readiness Baseline

This checklist freezes the pre long-term baseline before architectural work
such as incremental scanning or an MCP server begins.

## Required Validation

Run the local validation sequence before merging parser, graph, CLI, or schema
changes:

```bash
npm run typecheck
npm test
npm run build
npm run smoke:samples -- --suite standing --report .concentrate/smoke-standing-report.json --semantic-samples 5
```

For the same local sequence as a single release-candidate command, run:

```bash
npm run verify:rc
```

Run the heavier real-repository validation when changes affect import
resolution, workspace/package modeling, backend semantics, data access,
Kuzu writing, or smoke report generation:

```bash
npm run smoke:samples -- --suite internet --report .concentrate/smoke-internet-report.json --semantic-samples 5
```

Use `npm run verify:rc` for ordinary local release-candidate checks. Add the
internet smoke command when a change touches architecture, resolver behavior, or
large-repository performance.

Run the incremental benchmark after changes to manifests, parse planning, Kuzu
patch writes, or large-repository performance:

```bash
npm run benchmark:incremental
```

For a smaller standing-only pass:

```bash
npm run smoke:samples -- --suite standing --incremental-benchmark --report .concentrate/incremental-standing-benchmark-report.json --semantic-samples 5
```

## Current Baseline

- Schema version: 34.
- Node runtime: Node.js 22 or newer.
- Standing smoke report: `.concentrate/smoke-standing-report.json`.
- Internet smoke report: `.concentrate/smoke-internet-report.json`.
- Incremental benchmark report: `.concentrate/incremental-benchmark-report.json`.
- Standing sample databases:
  - `.concentrate/express.kuzu`
  - `.concentrate/fastify.kuzu`
  - `.concentrate/nestjs.kuzu`
  - `.concentrate/ky.kuzu`
- Internet sample databases:
  - `.concentrate/internet-node-express-firebase-mongodb.kuzu`
  - `.concentrate/internet-node-express-realworld.kuzu`
  - `.concentrate/internet-nest.kuzu`

## Validation Artifacts

The `.concentrate/*.kuzu` databases, `.concentrate/*report.json` files, and
`.concentrate/*manifest*.json` files are generated validation artifacts. They
are useful for manual inspection and regression triage, but they are not source
files and should not be committed.

Incremental scan work currently uses manifests and parse plans for eligibility
and graph patching. Pass `--previous-manifest <path>` to `scan` or `export` to
compare the current file hashes with a prior run. Pass `--incremental
changed-files` to request changed-file-only planning. The `scan` command can
patch an existing compatible Kuzu graph by deleting stale file-owned nodes and
writing graph slices for added and changed files. Parsing still runs over the
full supported file set until unchanged graph slice preservation is implemented.

Incremental patching is safe to use when:

- The previous manifest came from the same project root and include/exclude
  scope as the current scan.
- The target Kuzu database was produced by the same schema version.
- The previous graph has not been manually edited between scans.
- You can tolerate full parsing still running while graph writes are patched.

Use a full scan when the schema changed, the previous manifest is missing or
incompatible, include/exclude scope changed, or the graph database may be stale.
The CLI reports these cases as `Graph write: reset`.

## Expected Green Baseline

- `npm run typecheck`: passes.
- `npm test`: passes all unit and integration tests.
- `npm run build`: passes TypeScript build.
- Standing smoke suite: passes Express, Fastify, NestJS starter, and Ky.
- Internet smoke suite: passes Node Express Firebase MongoDB, Node Express
  RealWorld, and the large Nest repository. The Nest sample is expected to be a
  partial scan with two known failed decorator spec files.
