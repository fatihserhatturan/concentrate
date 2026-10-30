# Sample Repositories

This document tracks external repositories used for scanner smoke tests and
golden sample tests.

## Fetching

Every sample is pinned to a commit in [`scripts/samples.json`](../scripts/samples.json):
the last default-branch commit before 2026-05-01, when the expected counts below
were recorded. Fetch them (shallow, idempotent) with:

```bash
npm run samples:fetch                      # standing suite
npm run samples:fetch -- --suite all       # standing + internet
```

Samples land in `.concentrate/samples/<name>`; set `CONCENTRATE_SAMPLES_DIR` to
use another directory. The smoke runner, `npm run test:samples` and the golden
sample test (`tests/golden-samples.test.ts`) all read from there.

| Sample | Suite | Repository | Pinned commit |
| --- | --- | --- | --- |
| express | standing | expressjs/express | `6340c1eaaedc0ddcae8be8df2cdb1d2e961cbf2f` |
| fastify | standing | fastify/example | `10ab6cdde7a60d1fcf8cc8cd8e84cfde0b3708e8` |
| nestjs-starter | standing | nestjs/typescript-starter | `c4d9330f5513eda0fb5df594f6b34a11fde1a934` |
| ky | standing | sindresorhus/ky | `e0fcf780de2bd69af2528e4b7b87ccae6bb727b1` |
| internet-node-express-firebase-mongodb | internet | JDIZM/node-express-firebase-mongodb | `269ab2619cf320bb38eb821e95a35dd9ad772770` |
| internet-node-express-realworld | internet | gothinkster/node-express-realworld-example-app | `30b68e1e881462b2f4164ea09ab4c4f5699c7b0b` |
| internet-nest | internet | nestjs/nest | `958ff952c00bd5a25efa04ffaafac28721af7827` |
| internet-realworld-fullstack | internet | gothinkster/node-express-realworld-example-app in `backend/`, reck1ess/next-realworld-example-app in `frontend/` | `30b68e1e881462b2f4164ea09ab4c4f5699c7b0b`, `be9ef569bc395975d98c1973fac23ba9277797e7` |

A sample with `parts` is assembled from several repositories, each cloned
into its own directory of the sample, so the frontend and the backend are
scanned as one project. `apiOrigins` in the manifest is passed to the scan
like `--api-origin`.

At these commits every recorded count reproduces exactly, except ky's
`discoveredFiles` (67 instead of 68: the original local clone had one extra
untracked file).

## Backend Smoke Scans

Run these samples after backend-semantic parser or graph changes. The expected
counts are intentionally high level so they catch broad regressions without
pinning every parser detail.

Run all configured smoke samples with:

```bash
npm run smoke:samples
```

Run only the standing samples or internet validation samples with:

```bash
npm run smoke:samples -- --suite standing --report .concentrate/smoke-standing-report.json
npm run smoke:samples -- --suite internet --report .concentrate/smoke-internet-report.json
```

Run no-change parse-cache benchmarks (full scan, cold cache, warm cache; the
warm scan must reproduce the full graph) across standing and internet samples
with:

```bash
npm run benchmark:incremental
```

For standing-only benchmark checks:

```bash
npm run smoke:samples -- --suite standing --incremental-benchmark --report .concentrate/incremental-standing-benchmark-report.json
```

The smoke runner scans each repository, writes a graph store, checks expected
scan counts and semantic graph counts, and writes a machine-readable JSON
report.

Readers (`stats`, `query`, `mcp`) never lock a store. A `scan` waits for another
scan writing the same store; pass `--no-retry-lock` to make it fail at once.

Each smoke result also includes `semanticSamples`: top route, entrypoint,
env/config, and data-access rows with file and line metadata for quick manual
review. Use `--semantic-samples <n>` to change the per-category sample size.
The report includes empty false-positive and false-negative review arrays so
manual findings can be recorded next to the sample rows.

### Express

- Repository: `https://github.com/expressjs/express`
- Local path: `.concentrate/samples/express`
- Graph store: `.concentrate/express.graph`
- Last scan command:

```bash
npm run dev -- scan .concentrate/samples/express --database .concentrate/express.graph
```

- Example stats command:

```bash
npm run dev -- stats --database .concentrate/express.graph
```

- Last scan result, 2026-10-27: 213 discovered files, 141 supported files,
  141 parsed files, 0 failed files, 158 resolved imports, 0 unresolved
  relationships, 12879 nodes, 14052 relationships.
- File classification counts: 50 production files, 91 test files, 0 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 36, 91 `Route` nodes, 57 routes with
  non-null `fullPath`, 65
  `ROUTE_HANDLED_BY` relationships, 65 `ROUTE_LIFECYCLE_STEP`
  relationships, 9 `LIFECYCLE_PRECEDES` relationships, 2 `EnvVar` nodes, 5
  `ConfigValue` nodes, 0 `EntryPoint` nodes, 0 `DataModel` nodes.

### Fastify

- Repository: `https://github.com/fastify/example`
- Local path: `.concentrate/samples/fastify`
- Graph store: `.concentrate/fastify.graph`
- Last scan command:

```bash
npm run dev -- scan .concentrate/samples/fastify --database .concentrate/fastify.graph
```

- Example stats command:

```bash
npm run dev -- stats --database .concentrate/fastify.graph
```

- Last scan result, 2026-10-27: 45 discovered files, 18 supported files,
  18 parsed files, 0 failed files, 10 resolved imports, 1 unresolved
  relationship, 398 nodes, 454 relationships.
- File classification counts: 11 production files, 7 test files, 0 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 36, 1 `Route` node, 1 route with
  non-null `fullPath`, 1 `ROUTE_HANDLED_BY` relationship, 1
  `ROUTE_LIFECYCLE_STEP` relationship, 0 `LIFECYCLE_PRECEDES`
  relationships, 2 `EnvVar` nodes, 0 `ConfigValue` nodes, 0 `EntryPoint`
  nodes, 0 `DataModel` nodes.

### NestJS

- Repository: `https://github.com/nestjs/typescript-starter`
- Local path: `.concentrate/samples/nestjs-starter`
- Graph store: `.concentrate/nestjs-starter.graph`
- Last scan command:

```bash
npm run dev -- scan .concentrate/samples/nestjs-starter --database .concentrate/nestjs-starter.graph
```

- Example stats command:

```bash
npm run dev -- stats --database .concentrate/nestjs-starter.graph
```

- Last scan result, 2026-10-27: 16 discovered files, 7 supported files,
  7 parsed files, 0 failed files, 7 resolved imports, 13 unresolved
  relationships, 85 nodes, 112 relationships.
- File classification counts: 5 production files, 2 test files, 0 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 36, 1 `Route` node, 1 route with
  non-null `fullPath`, 1
  `MODULE_CONTROLS` relationship, 1 `MODULE_PROVIDES` relationship, 1
  `INJECTS` relationship, 0 `ROUTE_LIFECYCLE_STEP` relationships, 0 `EnvVar`
  nodes, 9 `ConfigValue` nodes, 0 `EntryPoint` nodes, 0 `DataModel` nodes.

## Ky

- Repository: `https://github.com/sindresorhus/ky`
- Local path: `.concentrate/samples/ky`
- Graph store: `.concentrate/ky.graph`
- Last scan command:

```bash
npm run dev -- scan .concentrate/samples/ky --database .concentrate/ky.graph
```

- Example stats command:

```bash
npm run dev -- stats --database .concentrate/ky.graph
```

- Last scan result, 2026-10-27: 68 discovered files, 52 supported files,
  52 parsed files, 0 failed files, 134 resolved imports, 0 unresolved
  relationships, 7013 nodes, 8497 relationships.
- File classification counts: 29 production files, 23 test files, 0 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 36, 0 `Route` nodes, 2 `EnvVar`
  nodes, 10 `ConfigValue` nodes, 0 `EntryPoint` nodes, 0 `DataModel` nodes.

## Internet Validation Scans

These repositories were downloaded on 2026-05-01 to exercise the scanner against
small, medium, and large real-world Node.js/TypeScript codebases beyond the
standing smoke samples.

### Node Express Firebase MongoDB

- Scale: small
- Repository: `https://github.com/JDIZM/node-express-firebase-mongodb`
- Local path: `.concentrate/samples/internet-node-express-firebase-mongodb`
- Graph store: `.concentrate/internet-node-express-firebase-mongodb.graph`
- Last scan result, 2026-10-27: 40 discovered files, 24 supported files,
  24 parsed files, 0 failed files, 22 resolved imports, 28 unresolved
  relationships, 514 nodes, 631 relationships.
- File classification counts: 20 production files, 3 test files, 0 fixture
  files, 0 support files, 1 generated file.
- Expected smoke counts: schema version 36, 7 `Route` nodes, 2 `EnvVar`
  nodes, 14 `ConfigValue` nodes, 1 `DataModel` node, 1 `Table` node (a
  MongoDB collection from `prisma/schema.prisma`).
- Notes: exposed a `tsconfig.json` parsing bug where glob strings such as
  `@/*` and `**/*.test.ts` were incorrectly treated as comments; fixed by
  making JSONC comment stripping string-aware.

### Node Express RealWorld

- Scale: medium
- Repository: `https://github.com/gothinkster/node-express-realworld-example-app`
- Local path: `.concentrate/samples/internet-node-express-realworld`
- Graph store: `.concentrate/internet-node-express-realworld.graph`
- Last scan result, 2026-10-27: 67 discovered files, 39 supported files,
  39 parsed files, 0 failed files, 49 resolved imports, 22 unresolved
  relationships, 692 nodes, 1069 relationships.
- File classification counts: 29 production files, 7 test files, 0 fixture
  files, 3 support files, 0 generated files.
- Expected smoke counts: schema version 36, 26 `Route` nodes, 4 `EnvVar`
  nodes, 9 `ConfigValue` nodes, 4 `DataModel` nodes, 4 `Table` nodes (from
  `src/prisma/schema.prisma`).

### RealWorld Fullstack

- Scale: medium
- Repositories: the RealWorld Express backend (above) in `backend/` and
  `https://github.com/reck1ess/next-realworld-example-app` (Next.js pages
  router, SWR and axios) in `frontend/`.
- Local path: `.concentrate/samples/internet-realworld-fullstack`
- Scan options: `apiOrigins: ["https://conduit.productionready.io"]`, the
  deployed API the frontend calls (`SERVER_BASE_URL`).
- Last scan result, 2026-10-30: 165 discovered files, 101 supported files,
  100 parsed files, 1 failed file (`frontend/pages/_document.tsx`: a bare `&`
  in a JSX attribute string, see [known-limitations.md](known-limitations.md)),
  181 resolved imports, 1599 nodes, 2420 relationships.
- Expected smoke counts: 26 `Route` nodes and 32 `REQUESTS` edges (31 from
  the frontend, 1 from the backend's e2e test); the hand labels are in
  [accuracy.md](accuracy.md).

### Nest

- Scale: large
- Repository: `https://github.com/nestjs/nest`
- Local path: `.concentrate/samples/internet-nest`
- Graph store: `.concentrate/internet-nest.graph`
- Last scan result, 2026-10-27: 2115 discovered files, 1714 supported files,
  1712 parsed files, 2 failed files, 4914 resolved imports, 1395 unresolved
  relationships, 52723 nodes, 69023 relationships.
- File classification counts: 985 production files, 351 test files, 376 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 36, 309 `Route` nodes, 3 `EntryPoint`
  nodes, 9 `EnvVar` nodes, 144 `ConfigValue` nodes, 7 `DataModel` nodes, 7
  `Table` nodes (three Mongoose `cats` collections, two TypeORM `photo`
  entities, TypeORM `user`, and Prisma `Post`).
- Data-access validation, 2026-05-02: detected large Nest models `Cat`
  (Mongoose), `Photo`, `User`, and `Mongo` (TypeORM) and propagated accesses
  from repository/service methods to controllers where call resolution was
  available. `Mongo` came from `MongoRepository<Photo>` read as a model name;
  since 2026-10-29 that is the `Photo` entity, and each access links to the
  entity or schema declared in its own sample.
- Write benchmark, 2026-05-01: transaction write mode completed the full scan
  and write in 24.60 seconds; the legacy individual write mode completed the
  same scan and write in 333.45 seconds.
- Partial scan validation, 2026-05-01: running without excludes and with
  `--continue-on-error` produced a queryable partial graph in 24.36 seconds,
  preserving 2 failed decorator spec files in the report while writing 27348
  nodes and 35045 relationships.
- Notes: the full scan found 2 parser failures in decorator spec files; the
  validation DB can now be produced either by excluding those two spec files or
  by using `--continue-on-error` to keep a partial graph. Large graph validation
  showed that wrapping graph writes in a manual Kuzu transaction is the first
  required production-scale write path. (Historical: Kuzu and
  `--kuzu-write-mode` were removed in Phase 2; the built-in store writes the
  whole express graph in about 12 ms, see [benchmarks.md](benchmarks.md).)
