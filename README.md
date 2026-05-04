# Concentrate

Scans a codebase, extracts a structural code graph, and stores it in an embedded [KuzuDB](https://kuzudb.com) graph database.

## Supported Languages

JavaScript / TypeScript · Python · Go · Rust

## What It Extracts

- **Structural nodes** — File, Function, Class, Import, Variable, Decorator, Entrypoint
- **HTTP routes** — Express, Koa, Fastify, NestJS (with full composed path resolution)
- **Dependency injection** — NestJS constructor injection chains
- **Environment usage** — `process.env.*` accesses linked to routes and functions
- **Data access** — Prisma, TypeORM, Sequelize, Knex, Mongoose ORM call detection
- **Import resolution** — relative, tsconfig path aliases, Go module paths, Rust crate paths

## Usage

```bash
npm install

# Scan a project into a graph database
npm run dev -- scan ./path/to/project

# Show graph statistics
npm run dev -- stats

# Run a Cypher query
npm run dev -- query "MATCH (f:File)-[:DEFINES_FUNCTION]->(fn:Function) RETURN f.relativePath, fn.name LIMIT 10"

# Export graph as JSONL
npm run dev -- export ./path/to/project --output .concentrate/export

# Start MCP server (for AI tool integration)
npm run dev -- mcp
```

## Architecture

```
src/
  index.ts          — CLI binary entry point
  adapters/
    cli/            — Command adapters (scan, stats, query, export, smoke, mcp)
    kuzu/           — KuzuDB writer, schema, retry
    mcp/            — MCP server adapter
  commands/         — Commander-wired CLI command definitions
  core/
    contracts/      — Language-agnostic interfaces
    graph/          — Graph model (GraphNode, GraphRelationship, GraphBuilder)
    integrations/   — Default parser + contributor registry
    scan/           — Orchestration, file discovery, manifest, report
      resolution/   — Language-agnostic call/inheritance/import resolution
  integrations/
    frameworks/js-ts/   — Express, Fastify, NestJS, env-config, data-access semantics
    languages/          — Go, Python, Rust, JS/TS parsers and resolution
  types/            — Ambient type declarations for tree-sitter bindings
```

## Development

```bash
npm test                  # unit tests
npm run typecheck         # TypeScript check
npm run build             # compile to dist/
npm run verify:rc         # typecheck + tests + build + standing smoke
```
