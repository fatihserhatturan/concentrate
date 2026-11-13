# Getting started

Concentrate is not published to npm (not planned for now, see the
[roadmap](ROADMAP.md)), so it runs from a checkout. It needs Node.js 22 or
newer. `npm install` compiles nothing: the only runtime dependency,
`web-tree-sitter`, is plain JavaScript and WebAssembly.

```bash
git clone https://github.com/fatihserhatturan/concentrate.git
cd concentrate
npm install
npm run build        # optional: compiles the CLI to dist/ (bin: concentrate)
```

## Usage

```bash
# Scan a project into the graph store (.concentrate/graph)
npm run dev -- scan ./path/to/project

# Show graph statistics
npm run dev -- stats

# Run a Cypher query (subset: docs/cypher.md); $name placeholders come from --param
npm run dev -- query "MATCH (f:File)-[:DEFINES_FUNCTION]->(fn:Function) RETURN f.relativePath, fn.name LIMIT 10"
npm run dev -- query "MATCH (fn:Function) WHERE fn.name = \$name RETURN fn.line" --param name=main

# Keep the graph current: rescan on every file change (uses the parse cache)
npm run dev -- watch ./path/to/project

# Export graph as JSONL
npm run dev -- export ./path/to/project --output .concentrate/export

# Start MCP server (for AI tool integration)
npm run dev -- mcp

# Test files that reach changed files through imports and calls
git diff --name-only | npm run dev -- affected --stdin
npm run dev -- affected src/util.ts --json

# Write the MCP config of Claude Code, Cursor and Codex into a project
npm run dev -- init ./path/to/project

# Start the optional local web interface (needs ui/ installed, see below)
npm run dev -- ui
```

The Cypher subset is described in [cypher.md](cypher.md).

## The optional UI

A local web interface lives in `ui/`: pick a directory, scan it, look at the graph, run the
question presets or a read-only Cypher query, and export the graph (JSON, JSONL, GraphML, DOT or a
single HTML file). It is a separate package with its own dependencies; `npm install` at the root
installs nothing for it, and the core never imports from it.

```bash
npm run build            # the UI imports the built core (dist/)
cd ui
npm install
npm start                # builds the web app, starts the server, opens the browser
```

Once `ui/` is installed, `npm run dev -- ui` (or `concentrate ui`) starts it from the root (`--port`, `--no-open`);
without it, the command prints these steps. The server listens on `127.0.0.1` only, every API call needs
the random token in the URL it prints, and a scan writes `<project>/.concentrate/graph`, the same graph
`concentrate mcp` and `concentrate query` read. [ui/README.md](../ui/README.md) has the details.

## Connect an AI agent

`concentrate mcp` serves the scanned graph to any MCP client over stdio. It
offers 28 tools, a graph summary resource, and paged, structured results.
[mcp-server.md](mcp-server.md#run) has the client configuration and
[mcp-server.md](mcp-server.md#tools) the tool reference. `concentrate init
<path>` writes the client configuration for Claude Code, Cursor and Codex
into the project, with an absolute `--database` path.

## Scans

- **Parse cache.** Repeated scans reuse per-file parse results from
  `.concentrate/cache/`, so only changed files are parsed again. Cross-file
  resolution always runs over the whole graph, so the result is the same as a
  full scan. A code or grammar change invalidates the cache automatically;
  `--no-cache` skips it.
- **Workers.** When 100 or more files need parsing, they are parsed on up to 4
  worker threads. `--workers <n>` sets the count and `--workers 0` keeps
  parsing on the main thread; the graph is the same either way.
- **Concurrent use.** Scans and the MCP server can run at the same time. A
  scan takes a writer lock and commits a new snapshot atomically, readers
  never lock, and a running MCP server picks up the new snapshot on its next
  tool call. A second scan waits for the first (`--no-retry-lock` makes it
  fail instead).
- **Large repositories.** `--exclude <glob>` (repeatable) skips paths, and
  `--continue-on-error` keeps the scan going past files that fail to parse.
- **Deployed APIs.** A frontend that calls its backend by its public URL
  (`https://api.example.com/users`) links to the scanned routes once that
  origin is declared: `--api-origin https://api.example.com` (repeatable)
  treats it like `localhost`. Calls to other origins stay unlinked.

- **Project settings.** A `concentrate.json` at the project root is read by
  every scan (and by `watch`). All keys are optional:

  ```json
  {
    "extensions": { ".mjsx": "javascript" },
    "include": ["src/**"],
    "exclude": ["**/*.gen.ts"],
    "deprioritize": ["legacy/**"],
    "apiOrigins": ["https://api.example.com"]
  }
  ```

  `extensions` maps a file extension to a language, for files the scanner
  would read as plain text. `include`, `exclude` and `apiOrigins` are as the
  `--include`, `--exclude` and `--api-origin` flags; the command line's
  `--include` replaces the file's, the other two are added to it.
  Inside a git repository, a subfolder that has its own `.git` (a worktree,
  submodule or clone) is skipped, since it is another copy of code; an
  `include` pattern that names a path inside it brings it back (`"include":
  ["**/*", "vendor/lib/**"]`).
  `deprioritize` lists files that stay in the graph but rank lower in
  `search_symbols` (their rows say `deprioritized: true`). An unknown key, a
  broken file or an unknown language stops the scan with a message naming it.
- **CI checks.** `concentrate cycles` and `concentrate unused` print import
  cycles and unused-export candidates from the graph store and exit 1 when
  there are more than `--max` (default 0). `cycles` leaves out cycles that only
  go through type-only imports unless `--include-type-only`, and takes
  `--scope package` and `--path`; both take `--json`. Start from a project's
  current count with `--max`.
- **Git hooks.** `concentrate init --hooks` installs `post-commit`,
  `post-checkout` (branch switches only) and `post-merge` hooks that rescan the
  project in the background; the project must be a git work tree, existing hooks
  keep their content (the scan sits between `# >>> concentrate (managed) >>>`
  markers and a rerun replaces it), and `core.hooksPath` is respected. With the
  MCP server's `--watch` the hooks are rarely needed.

What the graph can and cannot see is listed in
[known-limitations.md](known-limitations.md).
