# MCP Server

Concentrate can expose a scanned graph as a read-only Model Context
Protocol server over stdio.

## Run

Scan a project first:

```bash
npm run scan -- /path/to/project --database .concentrate/graph
```

Start the MCP server:

```bash
npm run mcp -- --database .concentrate/graph
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
    "/absolute/path/to/.concentrate/graph"
  ]
}
```

The server writes JSON-RPC responses to stdout and keeps graph access read-only.

Use an absolute database path in long-running editor/client configurations so
the MCP process does not depend on the client's working directory.

## Protocol

The server speaks both eras of MCP over newline-delimited JSON-RPC on stdio
and keeps no session state.

- **Modern (2026-07-28).** There is no handshake. Every request carries the
  protocol version in `params._meta["io.modelcontextprotocol/protocolVersion"]`.
  `server/discover` returns `supportedVersions`, `capabilities`
  (`tools`, `resources`) and short `instructions`. Every result has
  `resultType: "complete"` and names the server in
  `_meta["io.modelcontextprotocol/serverInfo"]`. List and read results carry
  `ttlMs` and `cacheScope`: the tool and resource lists are `public` and change
  only with the build; resource contents are `private` with `ttlMs: 0`, since
  every scan changes them. A version other than 2026-07-28 gets error `-32022`
  with `data: { supported, requested }`. `ping` is not part of this era.
- **Legacy (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05).** `initialize`
  echoes the client's `protocolVersion` when it is one of these and otherwise
  answers `2025-11-25`. Requests without the `_meta` version, `ping` among
  them, get the legacy result shapes.

Errors:

- Unknown methods return `-32601`. An unknown tool, an unknown resource or a
  malformed `tools/call` (no name, non-object arguments) returns `-32602`.
- Failures inside a tool (a missing argument, an invalid cursor, git failing
  in `detect_changes`) are tool results with `isError: true` and the message
  as text, so the model can read and correct them.

Tool results return the JSON twice: as `structuredContent` and as a compact
JSON text block for clients that only read `content`. Every tool has a
`title` and the annotations `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true` and `openWorldHint: false`.

Smoke test after scanning a graph:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph_stats","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}' \
  | npm run mcp -- --database /absolute/path/to/.concentrate/graph
```

A legacy client starts with
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"client","version":"1"}}}`
and sends the same `tools/call` without `_meta`.

## Resources

`resources/list` returns one resource, `concentrate://graph/summary`
(`application/json`): schema version, the repo root, file counts, languages,
packages with their file counts, the 15 largest directories (first two path
segments), routes by framework, entrypoints by kind, data models by library,
env var and config counts, and node counts per label. It is a few kilobytes
even for large repositories; read it first to decide which tools to call.

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
- `list_pages({ file?, framework?, path?, limit = 50 })`: UI pages from the
  Next.js App and Pages Router, React Router and TanStack Router, ordered by
  `fullPath`: the declaring `file` and `line`, `path` as declared, `router`,
  `kind` (`page`, `layout`, `index`, `lazy`, Next's `loading`, `error`, ...),
  Next's parallel-route `slot`, and the `component` it renders with its
  `componentFile`. `path` keeps pages under a prefix of whole segments
  (`/users` matches `/users/:id`, not `/usersettings`).
- `list_entrypoints`: lists non-HTTP backend entrypoints such as queues, cron
  jobs, events, realtime handlers, and schedulers.
- `list_env_config`: lists environment variable usage and config declarations
  or consumers.
- `list_data_access`: lists data-access operations by source, model, library,
  and operation. Each row has the model's `table` when one is known.
- `list_tables({ name?, library?, limit = 20 })`: database tables, views and
  collections from Prisma schema files, TypeORM entities, Mongoose schemas,
  Drizzle table definitions and Knex calls. Each table has its
  `columns` (with the database `column` name when `@map` renames it, and
  `isId` / `isUnique` / `optional` / `list` flags), the `models` that map to it
  with their `relations` (`field`, `kind` one or many, target `model`,
  `relationName`, `onDelete`), `readBy` / `writtenBy` counts of routes,
  entrypoints and functions, and up to 20 `routes` and `entrypoints` with the
  operations they perform. Answers "which endpoints write the users table?".

### Agent tools

These answer a whole question in one call instead of a chain of lookups.

- `impact_of({ symbol?, file?, maxDepth = 5, limit = 50 })`: what is affected
  if a function, method, class or file changes. A symbol selects functions with
  that name and the methods of a class with that name; a file selects every
  function in it; both together narrow the symbol to the file. Returns
  `callers` (transitive, with `depth`), `moduleCallers` (top-level code that
  calls the seeds or their callers), `routes` and `entrypoints` that run any of
  them (`reachedThrough` says which function and in which role),
  `components`: the UI components those functions implement (`depth: 0`,
  `changedThrough` names the functions) and the components that render them,
  following `RENDERS` up to `maxDepth` levels (`renders` names the child),
  `pages` that render any of those components (`renders` names it, `depth` is
  its depth), `apiConsumers`: the frontend calls that reach the affected routes
  (as in `api_consumers`), with `consumerComponents` and `consumerPages`, the
  components and pages whose code makes those calls (callers followed up to
  `maxDepth` levels), and the `dataAccess`, `tables`, `envVars` and `config` of the seeds themselves.
  For a route, use `route_details`.
- `detect_changes({ base = "HEAD", maxDepth = 5, limit = 50 })`: runs
  `git diff --unified=0 <base>` (no shell; `base` must look like a revision)
  plus untracked files, maps the changed lines onto declarations whose
  `line..endLine` span they touch, and returns the impact of the changed
  functions as in `impact_of`. Changed files the graph does not know are listed
  under `unscannedFiles`; rescan, or keep `concentrate watch` running, to
  include them. Fails when the scanned project is not in a git work tree.
- `route_details({ method, path, limit = 5 })`: for each matching route (method
  case-insensitive, path matched against the resolved full path or the path as
  declared): `handlers`, `lifecycle` steps (middleware, guards, hooks, ...) in
  order, the `callChain` from those functions (up to 4 levels, caller → callee
  with the call line), and the `dataAccess`, `tables`, `envVars` and `config`
  of the route and that chain (`usedBy` lists where each one is used). A
  `tables` entry has the table, its `kind` and `library`, and the `reads` and
  `writes` operations on it. A `GET` also returns `pages`, the UI pages whose
  full or declared path matches: each with its `router`, `kind` and file, the
  `component` it renders, and the `callChain`, `dataAccess`, `tables`,
  `envVars` and `config` of the functions that implement that component.
  `routes` may be empty when only pages match. Each route also lists its
  `consumers` (the frontend calls that reach it, as in `api_consumers`) and,
  when their code implements components, `consumerComponents` and
  `consumerPages`.
- `api_consumers({ method?, path?, routeFile?, framework?, file?, client?, limit = 50 })`:
  the calls linked to a route by `REQUESTS` (fetch, axios, ky, ofetch, SWR,
  TanStack Query, tRPC), filtered by the route's method, path (resolved full
  path or as declared), declaring file or framework, or by the calling `file`
  or `client`; with no filter, every linked call. Each consumer has its
  `route` (method, full path, framework, file, line), the `client`, the
  `method` and `url` as resolved, the `match` kind (`exact`, `parameter`,
  `catch-all`), and the calling `file`, `line`, `expression` and `function`
  (null for a top-level call).
- `get_symbol_source({ name, file?, kind?, limit = 5 })`: source text of a
  declaration, sliced from the file on disk with the span from the last scan
  (at most 400 lines each, `truncated: true` beyond). `Class.method` selects
  one class's method; `kind` is one of function, method, class, interface,
  type, enum, variable.
- `get_file_outline({ file })`: the declarations of one file from the graph in
  line order: imports, functions, classes with their methods and fields,
  interfaces, types, enums, variables, routes and entrypoints. `file` can be a
  unique path suffix; several matches return `candidates`.
- `component_tree({ name, file?, depth = 2, limit = 5 })`: for each component
  with that name: its `kind`, file and span, `definedBy` (its function, or
  its class), `hooks` (every `use*` call by name), `customHooks` (the
  repository's hooks it calls, with the call line), `contexts` it reads
  directly or `through` a custom hook (followed through hooks that use other
  hooks), `renders` and `renderedBy` (render edges with `depth`, `parent`,
  `component`, the render `line` and the `props` passed, up to `depth` levels
  each way) and `unresolvedRenders` (elements that resolved to no component,
  such as library components).
- `find_component_usages({ name, file?, limit = 50 })`: every `render` of a
  component with that name (`from` is the rendering component, plus the file,
  line and `props`), and for a context the functions that read it (`kind:
  "context"`). Elements of that name that resolved to no component, such as
  `<Link>` from a library, are listed with `resolved: false` unless `file` is
  given. `counts` sums the usages by kind.

`file` arguments accept the scan-relative path or a path suffix
(`users/service.ts` matches `src/users/service.ts`).

Example:

```json
{ "name": "impact_of", "arguments": { "symbol": "UserService", "maxDepth": 3 } }
```

### Search and analysis tools

- `search_symbols({ query, kind?, file?, limit = 20 })`: fuzzy search over
  declarations (functions, methods, classes, interfaces, types, enums,
  variables). Matches rank by type: `exact`, `exact-ignore-case`, `prefix`,
  `initials` (`gUS` → `getUserService`), `substring` (higher at a word
  start), then `fuzzy` (the query's letters in order, as fzf does:
  `injctr` → `Injector`). Within a type, closer and shorter names score
  higher; ties go to the shorter name, then exported declarations, then file
  and line. Each result has `match` and `score`. A query with a dot
  (`Service.find`) is matched against `Class.method`.
- `find_references({ symbol, file?, kind?, limit = 50 })`: where a
  declaration is used, as references with `kind`, `file` and `line`:
  - `call` and `callback` from resolved call edges (`from` names the calling
    function or `(module)`);
  - `import` and `type-import` by name, followed through
    `export { a as b } from` and `export * from` barrels; `namespace-import`
    and `dynamic-import` of the declaration's file (or of a barrel that
    includes it) are marked `possible: true`;
  - `re-export` statements that pass the declaration on;
  - `route` and `entrypoint` for functions that handle them (`detail` is the
    role);
  - `extends`, `implements` and `injects` for classes and interfaces.
  `Class.method` selects one class's method (calls only). `counts` sums the
  references by kind.
- `find_import_cycles({ scope = "file", path?, limit = 20 })`: strongly connected
  components of the resolved file import graph (`scope: "package"`: of the
  workspace package dependency graph), largest first. Each has `size`, its
  `members` (the first 30), and `cycle`, one shortest loop through its first
  member. File cycles whose every loop passes a type-only import
  (`import type`) are `typeOnly: true`; `runtimeCycles` counts the others.
  Package cycles list the `dependencyTypes` on the example loop.
  `path` (a file, a directory anywhere in the path, or a path suffix; a
  package name with `scope: "package"`) keeps only the cycles with a matching
  member: `members` then lists just those (up to 30, `moreMembers` for the
  rest), `matchingMembers` counts them, `size` stays the whole group, and
  `cycle` runs through the first of them. Use it to see which files of one
  directory are in a large cycle.
- `find_unused_exports({ file?, includeTests = false, limit = 50 })`:
  candidate dead code in JavaScript and TypeScript files.
  - `unusedExports`: exported declarations that no other file imports by name
    (through barrels too), calls, passes as a callback, extends, implements,
    injects or lists in a NestJS module. `usedInFile: true` marks exports only
    used inside their own file.
  - `deadFunctions` (at most 100): unexported file-level functions with no
    resolved calls, not passed as callbacks, not handlers, and whose name is
    not mentioned anywhere else in their file (read from disk).
  - `skipped` counts what is not judged: exports of package entry points
    (`package.json` `main`, `module`, `types`, `browser`, `bin` and `exports`,
    mapped from build output back to sources, plus `index` and `src/index`;
    the scan root when there is no manifest) and of files imported whole
    (namespace, dynamic, CommonJS default, or a name that resolves to nothing,
    such as a default export), exports named `default`, route and entrypoint
    handlers, generated files, and test and fixture files unless
    `includeTests` is set.
- `architecture_overview({ level = "package", depth = 2, limit = 50 })`: the
  repository as `groups` (workspace packages, or with `level: "directory"`
  directories cut at `depth` path segments) with file, test file, language,
  function, class, route, entrypoint and data model counts and how many
  groups each depends on and is used by; `edges` between groups weighted by
  resolved file imports (`typeOnlyImports` among them) and, for packages, the
  manifest `dependencyTypes`, heaviest first. Files outside every package are
  counted under `ungroupedFiles`.

These tools work from the graph only. Calls the scanner could not resolve
(for example calls through an `export *` barrel to another package) are
missing from `find_references` and can make an export look unused; uses
from outside the repository, string-based lookups and framework conventions
are not seen, so `find_unused_exports` reports candidates to check, not
verdicts.

### Paging and output budget

Every tool that returns a list pages one primary list: `definitions`,
`callers`, `exports`, `routes`, `pages`, `entrypoints`, `envConfig`, `dataAccess`, and
for the agent tools `callers` (`impact_of`), `changedFiles`
(`detect_changes`), `routes` (`route_details`), `consumers` (`api_consumers`), `matches`
(`get_symbol_source`), `outline` (`get_file_outline`, `limit` defaults to
200), `components` (`component_tree`) and `usages` (`find_component_usages`),
and for the analysis tools `symbols`, `references`, `cycles`,
`unusedExports` and `edges` (`architecture_overview`). `limit` is the page size (at most 200). The result has a
`page: { offset, returned, nextCursor? }` field; pass `nextCursor` back as
`cursor` with the other arguments unchanged to get the next page. `limit` may
change between pages. A cursor from a different call, or one that was
altered, is rejected as a tool error. Pages follow each tool's fixed ordering;
if the graph is rescanned between pages, items can shift across a page
boundary.

`graph_stats` and `trace_import_chain` return a single answer and are not
paged.

Results are kept under 24,000 characters of JSON. A page that would be larger
ends early, with `page.shortenedToFit: true` and a `nextCursor` that continues
right after it. Other lists in a result (for example `routes` in `impact_of`)
are capped by `limit`; when they are still too large, the longest are halved
and a `truncated` object lists how many items each lost (for example
`{ "routes": 12 }`). Narrow the call (`file`, a lower `maxDepth`) to see them.

## Current Limits

- The first server pass is read-only and stdio-only.
- `trace_import_chain` follows resolved file-to-file import edges only.
- Backend semantic tools reflect the graph semantics already produced by the
  scanner; they do not execute application code or infer runtime framework
  configuration beyond scanned source relationships.
- Results depend on the existing graph quality and known parser/resolver
  limitations. Route handlers and middleware imported from another file are
  linked when they are bound by name (`import { listUsers } from './users'`,
  `const { auth } = require('./auth')`); default imports, namespace members
  (`handlers.list`) and re-export barrels are not followed yet.

## Troubleshooting

- If a client shows an empty graph, run `npm run scan -- <project>
  --database <path>` first and point MCP to the same database path.
- If a client starts MCP from another working directory, use an absolute
  `--database` path.
- The server never locks the store, so it can stay running while you scan. A
  finished scan is picked up on the next tool call; no restart is needed.
  Run `concentrate watch <project>` next to the server to keep the graph
  current while you edit.
- If the path is an old `.kuzu` database, the server reports it. Delete it and
  scan again (the default store is now the `.concentrate/graph/` directory).
- If a tool returns fewer semantic rows than expected, verify the graph with
  `npm run smoke:samples` and review known parser/resolver limitations.
