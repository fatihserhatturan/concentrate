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
  relationships, 3233 nodes, 3686 relationships.
- Expected smoke counts: schema version 27, 91 `Route` nodes, 65
  `ROUTE_HANDLED_BY` relationships.

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
  relationship, 337 nodes, 388 relationships.
- Expected smoke counts: schema version 27, 1 `Route` node, 1
  `ROUTE_HANDLED_BY` relationship.

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
  relationships, 58 nodes, 71 relationships.
- Expected smoke counts: schema version 27, 1 `Route` node, 1
  `MODULE_CONTROLS` relationship, 1 `MODULE_PROVIDES` relationship, 1
  `INJECTS` relationship.

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
