# Sample Repositories

This document tracks external repositories used for scanner smoke tests.

## Backend Smoke Scans

Run these samples after backend-semantic parser or graph changes. The expected
counts are intentionally high level so they catch broad regressions without
pinning every parser detail.

### Express

- Repository: `https://github.com/expressjs/express`
- Local path: `~/Desktop/concentrate-sample-express`
- Graph database: `.concentrate/express.kuzu`
- Last scan command:

```bash
npm run dev -- scan ~/Desktop/concentrate-sample-express --database .concentrate/express.kuzu
```

- Example stats command:

```bash
npm run dev -- stats --database .concentrate/express.kuzu
```

- Last scan result, 2026-05-01: 213 discovered files, 141 supported files,
  141 parsed files, 0 failed files, 158 resolved imports, 0 unresolved
  relationships, 3277 nodes, 3827 relationships.
- File classification counts: 50 production files, 91 test files, 0 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 33, 91 `Route` nodes, 57 routes with
  non-null `fullPath`, 65
  `ROUTE_HANDLED_BY` relationships, 65 `ROUTE_LIFECYCLE_STEP`
  relationships, 9 `LIFECYCLE_PRECEDES` relationships, 2 `EnvVar` nodes, 2
  `ConfigValue` nodes, 0 `EntryPoint` nodes, 0 `DataModel` nodes.

### Fastify

- Repository: `https://github.com/fastify/example`
- Local path: `~/Desktop/concentrate-sample-fastify`
- Graph database: `.concentrate/fastify.kuzu`
- Last scan command:

```bash
npm run dev -- scan ~/Desktop/concentrate-sample-fastify --database .concentrate/fastify.kuzu
```

- Example stats command:

```bash
npm run dev -- stats --database .concentrate/fastify.kuzu
```

- Last scan result, 2026-05-01: 45 discovered files, 18 supported files,
  18 parsed files, 0 failed files, 10 resolved imports, 1 unresolved
  relationship, 339 nodes, 392 relationships.
- File classification counts: 11 production files, 7 test files, 0 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 33, 1 `Route` node, 1 route with
  non-null `fullPath`, 1 `ROUTE_HANDLED_BY` relationship, 1
  `ROUTE_LIFECYCLE_STEP` relationship, 0 `LIFECYCLE_PRECEDES`
  relationships, 2 `EnvVar` nodes, 0 `ConfigValue` nodes, 0 `EntryPoint`
  nodes, 0 `DataModel` nodes.

### NestJS

- Repository: `https://github.com/nestjs/typescript-starter`
- Local path: `~/Desktop/concentrate-sample-nestjs`
- Graph database: `.concentrate/nestjs.kuzu`
- Last scan command:

```bash
npm run dev -- scan ~/Desktop/concentrate-sample-nestjs --database .concentrate/nestjs.kuzu
```

- Example stats command:

```bash
npm run dev -- stats --database .concentrate/nestjs.kuzu
```

- Last scan result, 2026-05-01: 16 discovered files, 7 supported files,
  7 parsed files, 0 failed files, 7 resolved imports, 13 unresolved
  relationships, 64 nodes, 77 relationships.
- File classification counts: 5 production files, 2 test files, 0 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 33, 1 `Route` node, 1 route with
  non-null `fullPath`, 1
  `MODULE_CONTROLS` relationship, 1 `MODULE_PROVIDES` relationship, 1
  `INJECTS` relationship, 0 `ROUTE_LIFECYCLE_STEP` relationships, 0 `EnvVar`
  nodes, 6 `ConfigValue` nodes, 0 `EntryPoint` nodes, 0 `DataModel` nodes.

## Ky

- Repository: `https://github.com/sindresorhus/ky`
- Local path: `~/Desktop/concentrate-sample-ky`
- Graph database: `.concentrate/ky.kuzu`
- Last scan command:

```bash
npm run dev -- scan ~/Desktop/concentrate-sample-ky --database .concentrate/ky.kuzu
```

- Example stats command:

```bash
npm run dev -- stats --database .concentrate/ky.kuzu
```

## Internet Validation Scans

These repositories were downloaded on 2026-05-01 to exercise the scanner against
small, medium, and large real-world Node.js/TypeScript codebases beyond the
standing smoke samples.

### Node Express Firebase MongoDB

- Scale: small
- Repository: `https://github.com/JDIZM/node-express-firebase-mongodb`
- Local path: `.concentrate/internet-samples/node-express-firebase-mongodb`
- Graph database: `.concentrate/internet-node-express-firebase-mongodb.kuzu`
- Last scan result, 2026-05-01: 40 discovered files, 24 supported files,
  24 parsed files, 0 failed files, 22 resolved imports, 28 unresolved
  relationships, 433 nodes, 484 relationships.
- File classification counts: 20 production files, 3 test files, 0 fixture
  files, 0 support files, 1 generated file.
- Expected smoke counts: schema version 33, 7 `Route` nodes, 2 `EnvVar`
  nodes, 10 `ConfigValue` nodes, 1 `DataModel` node.
- Notes: exposed a `tsconfig.json` parsing bug where glob strings such as
  `@/*` and `**/*.test.ts` were incorrectly treated as comments; fixed by
  making JSONC comment stripping string-aware.

### Node Express RealWorld

- Scale: medium
- Repository: `https://github.com/gothinkster/node-express-realworld-example-app`
- Local path: `.concentrate/internet-samples/node-express-realworld-example-app`
- Graph database: `.concentrate/internet-node-express-realworld.kuzu`
- Last scan result, 2026-05-01: 67 discovered files, 39 supported files,
  39 parsed files, 0 failed files, 49 resolved imports, 22 unresolved
  relationships, 536 nodes, 710 relationships.
- File classification counts: 29 production files, 7 test files, 0 fixture
  files, 3 support files, 0 generated files.
- Expected smoke counts: schema version 33, 26 `Route` nodes, 4 `EnvVar`
  nodes, 6 `ConfigValue` nodes, 4 `DataModel` nodes.

### Nest

- Scale: large
- Repository: `https://github.com/nestjs/nest`
- Local path: `.concentrate/internet-samples/nest`
- Graph database: `.concentrate/internet-nest.kuzu`
- Last scan result, 2026-05-01: 2113 discovered files, 1712 supported files,
  1712 parsed files, 0 failed files, 3770 resolved imports, 2539 unresolved
  relationships, 27348 nodes, 35045 relationships.
- File classification counts: 985 production files, 351 test files, 376 fixture
  files, 0 support files, 0 generated files.
- Expected smoke counts: schema version 33, 309 `Route` nodes, 3 `EntryPoint`
  nodes, 9 `EnvVar` nodes, 114 `ConfigValue` nodes, 0 `DataModel` nodes.
- Notes: the full scan found 2 parser failures in decorator spec files; the
  validation DB was produced by excluding those two spec files. Large graph
  writes also show that single-row Kuzu `CREATE` inserts are now the main
  performance bottleneck for production-scale repositories.
