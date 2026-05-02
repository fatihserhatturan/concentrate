# MCP Server

Concentrate can expose a scanned Kuzu graph as a read-only Model Context
Protocol server over stdio.

## Run

Scan a project first:

```bash
npm run scan -- /path/to/project --database .concentrate/graph.kuzu
```

Start the MCP server:

```bash
npm run mcp -- --database .concentrate/graph.kuzu
```

Example MCP client command configuration:

```json
{
  "command": "npm",
  "args": [
    "run",
    "mcp",
    "--",
    "--database",
    "/absolute/path/to/.concentrate/graph.kuzu"
  ]
}
```

The server writes JSON-RPC responses to stdout and keeps graph access read-only.

Use an absolute database path in long-running editor/client configurations so
the MCP process does not depend on the client's working directory.

## Compatibility Smoke

After scanning a graph, verify the stdio protocol with:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npm run mcp -- --database /absolute/path/to/.concentrate/graph.kuzu
```

Expected behavior:

- `initialize` returns the MCP protocol version, tool capability, and server
  info.
- `tools/list` returns all Concentrate tools.
- `tools/call` responses return MCP `content` blocks containing compact JSON
  text.

Example `tools/call` request:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "graph_stats",
    "arguments": {}
  }
}
```

## Tools

- `graph_stats`: returns schema version and node counts.
- `find_definitions`: finds symbols across functions, classes, variables,
  interfaces, type aliases, and enums.
- `find_callers`: finds call sites that resolve to a named function.
- `list_exports`: lists exported definitions and re-exports, optionally scoped
  to one file.
- `trace_import_chain`: returns a resolved import path between two files when
  one exists.
- `list_routes`: lists detected HTTP route declarations and handlers.
- `list_entrypoints`: lists non-HTTP backend entrypoints such as queues, cron
  jobs, events, realtime handlers, and schedulers.
- `list_env_config`: lists environment variable usage and config declarations
  or consumers.
- `list_data_access`: lists data-access operations by source, model, library,
  and operation.

## Current Limits

- The first server pass is read-only and stdio-only.
- Tool responses are compact JSON text payloads.
- `trace_import_chain` follows resolved file-to-file import edges only.
- Backend semantic tools reflect the graph semantics already produced by the
  scanner; they do not execute application code or infer runtime framework
  configuration beyond scanned source relationships.
- Results depend on the existing graph quality and known parser/resolver
  limitations.

## Troubleshooting

- If a client shows an empty graph, run `npm run scan -- <project>
  --database <path>` first and point MCP to the same database path.
- If a client starts MCP from another working directory, use an absolute
  `--database` path.
- If Kuzu reports a transient lock error, retry after active scans or query
  commands finish. The MCP command uses the same lock retry behavior as
  `query` and `stats`.
- If a tool returns fewer semantic rows than expected, verify the graph with
  `npm run smoke:samples` and review known parser/resolver limitations.
