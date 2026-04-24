# Concentrate

Concentrate scans a codebase, extracts a structural code graph, and stores it in an embedded graph database.

## First Milestone

- Discover source files while respecting common ignore rules.
- Extract file, import, class, function, and call-expression nodes.
- Persist the normalized graph into Kuzu.
- Query the graph through a small CLI.

## Commands

```bash
npm install
npm run dev -- scan ./path/to/project
npm run dev -- stats
npm run dev -- query "MATCH (f:File) RETURN f.path LIMIT 10"
npm run dev -- query "MATCH (f:File)-[:DEFINES_FUNCTION]->(fn:Function) RETURN f.relativePath, fn.name LIMIT 10"
```

## Architecture

```text
src/
  cli/        CLI entrypoint
  commands/   scan, stats, query commands
  graph/      normalized graph model and Kuzu writer
  parsers/    language-specific Tree-sitter extractors
  scanner/    file discovery, ignore handling, language detection
```
