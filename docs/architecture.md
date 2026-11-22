# Architecture

A scan runs in five stages, each with one owner:

1. **Discovery** (`core/scan`): finds files, applying include/exclude rules,
   the workspace manifest and package boundaries.
2. **Parsing** (`integrations/languages/syntax`): parses each file with
   tree-sitter on WebAssembly. This happens on worker threads for large scans,
   and results are cached per file.
3. **Extraction** (`integrations/languages`, `integrations/frameworks`):
   - language integrations turn syntax trees into graph nodes;
   - framework contributors add routes, dependency injection, environment and
     data-access facts on top.
4. **Resolution**: links imports, calls and inheritance across files over the
   whole graph. Each language supplies its own resolvers
   (`integrations/languages/*`); `core/scan/resolution` holds the default
   lookup for files no resolver claims.
5. **Storage and querying** (`adapters/store`):
   - the graph is written as an atomic snapshot under a writer lock;
   - it is read through a read-only Cypher subset;
   - it is served by the CLI and the MCP adapter.

The core does not know about languages or frameworks. They plug in through
contracts in `core/contracts`, and `composition/` wires the default set. The
design and the rules each layer follows are in
[layered-core-architecture.md](layered-core-architecture.md).

## Source layout

```
src/
  index.ts          — CLI binary entry point
  api.ts            — Public API: registry, contracts, scan and store entry points
  program.ts        — Command, argument and flag definitions
  commands/         — CLI command entry points
  adapters/
    cli/            — Command adapters (scan, stats, query, export, smoke, mcp) and the parseArgs router
    store/          — Graph store: in-memory graph, snapshots, writer lock, schema
      cypher/       — Read-only Cypher subset: lexer, parser, binder, planner, executor
    mcp/            — MCP server adapter
    fs/             — Node file system, content hasher, parse cache, source reader
    git/            — Change source for detect_changes
  composition/      — Default registry, default schema, orchestrator, parse worker pool, scan-into-store (core ← integrations)
  core/
    contracts/      — Language-agnostic interfaces: language descriptor, parser, call/import/inheritance resolvers,
                      semantic contributor, unused-export rules, ports
    graph/          — Graph model, builder, base schema as data, normalize, JSONL
    integrations/   — CoreIntegrationRegistry and the registry-module contract
    queries/        — Use cases shared by MCP, CLI and UI, over IQueryEngine
    scan/           — Orchestration, file discovery, manifest, report
      resolution/   — Default call, inheritance and name lookup
  integrations/
    languages/      — One directory per language (plain, js-ts, python, go, rust, cpp, java, csharp): descriptor,
                      parser, call/import/inheritance resolvers, unused rules, schema
      syntax/       — tree-sitter on WebAssembly (the only web-tree-sitter importer)
      file-kind.ts  — isXFile helpers built from the descriptors
    frameworks/     — cpp, csharp, go, java, js-ts, proto, python, rust, scripts, sql, styles: routes, dependency
                      injection, environment, data-access and other framework facts
    resolution/     — imports.ts dispatches to the registered import resolvers
vendor/grammars/    — Prebuilt tree-sitter grammars (.wasm) and their manifest
```

A new language adds a directory under `integrations/languages/` and registers
in `composition/default-registry.ts`; see [adding-a-language.md](adding-a-language.md).

## Dependencies

Concentrate has a single runtime dependency, `web-tree-sitter` (plain JS and
WebAssembly, no install scripts), so `npm install` never compiles native code.
The graph store, the Cypher engine, the CLI argument parser and file discovery
are built in. Grammars are vendored as `.wasm` files with a sha256 manifest.
[ROADMAP.md](ROADMAP.md) records how each dependency was replaced.
