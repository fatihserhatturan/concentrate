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

Write the client configuration into the project:

```bash
npm run dev -- init /path/to/project
```

`init` writes the `concentrate` server into each client's project config and
keeps the servers and settings already there:

| Client | File |
| --- | --- |
| Claude Code | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| Codex | `.codex/config.toml` (`[mcp_servers.concentrate]`; Codex reads it only in trusted projects) |

`--client claude|cursor|codex` (repeatable) picks the clients; all three by
default. The server command is this build's CLI under the current Node with
an absolute `--database` path, `<path>/.concentrate/graph` unless `-d` names
another. `--npx` writes `npx -y concentrate mcp …` instead, for an installed
package. When the graph does not exist yet, `init` prints the scan command.
Running it again replaces only the `concentrate` entry.

Example MCP client command configuration by hand:

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

The tool list is part of every request an agent sends, so it is kept short:
names, descriptions and input schemas come to about 18,000 characters (about
4,500 tokens) for the 26 tools. Rules that hold for every tool (paging, the
24,000-character result budget) are stated once in the server
`instructions`, not in each description; an argument without `required` is
optional. The instructions also name, for every tool, the question it answers
better than grep (callers and references resolved through imports and
barrels, change impact, route consumers, store and table users, cycles and
unused exports), since agents otherwise search the text first.

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
  interfaces, type aliases and enums, then class methods (`kind: "Method"`
  with `className`, including class fields that hold a function). Takes
  `sourceType` and `language` (see below).
- `find_callers`: finds call sites that resolve to a named function. It also
  returns `unresolvedCalls` (`count` and up to 10 `sites` with file, line,
  expression and caller): calls with that callee name that resolve to no
  function, such as calls on library objects or dynamic receivers, or callers
  the graph missed. `completeness` says what that means: with a count of 0,
  every call by that name is among the resolved callers, so the answer needs
  no grep to confirm; otherwise the sites are the lines to check. A substring
  search (`exact: false`) checks the names of up to 20 matching functions.
- `list_exports`: lists exported definitions and re-exports, optionally scoped
  to one file; takes `sourceType` and `language`.
- `trace_import_chain`: returns a resolved import path between two files when
  one exists.
- `list_routes`: lists detected HTTP route declarations and handlers, Go
  ones included (`framework` `gin`, `echo`, `chi`, `fiber`, `gorilla/mux`,
  `routegroup`, `kratos` or `net/http`), and Rust ones (`axum`, `actix-web`, `rocket`
  or `warp`; each route also carries its `layers` and the handler's `extractors`), and Python ones (`flask`, `fastapi`, `starlette`, `django`, `django-rest-framework` or `flask-restful`; FastAPI routes carry their `Depends` as `layers`, Django ones their `MIDDLEWARE`).
  Registrations with a method or path computed at runtime
  (`app[method](url, fn)`, `this.get(path, …)` in an `app.resource = function`
  helper) are not routes; they come back in `dynamicRouteCalls` (`file`,
  `line`, `expression`, `framework`, at most 20) with a `dynamicNote`
  giving their count. `unconsumed: true` keeps only the routes no `Call` in
  the graph requests (`REQUESTS`, as in `api_consumers`), leaving out
  middleware mounts (`USE`): in a scan with its frontend, candidate dead
  endpoints. When the graph has no `REQUESTS` at all (a backend scanned
  alone), every route is listed with an `unconsumedNote` saying so.
- `list_pages({ file?, framework?, path?, limit = 50 })`: UI pages from the
  Next.js App and Pages Router, React Router and TanStack Router, ordered by
  `fullPath`: the declaring `file` and `line`, `path` as declared, `router`,
  `kind` (`page`, `layout`, `index`, `lazy`, Next's `loading`, `error`, ...),
  Next's parallel-route `slot`, and the `component` it renders with its
  `componentFile`. `path` keeps pages under a prefix of whole segments
  (`/users` matches `/users/:id`, not `/usersettings`).
- `list_entrypoints`: lists non-HTTP backend entrypoints such as queues, cron
  jobs, events, realtime handlers, and schedulers; for Go also `main` /
  `init`, gRPC service methods (kind `grpc`, trigger `Service/Method`) and
  cobra commands (kind `cli`, trigger the command path, `app serve`).
- `list_env_config`: lists environment variable usage and config declarations
  or consumers (Go reads too: `os.Getenv`, viper, env struct tags; and Rust: `std::env::var`, `env!`, clap `env`, envy, the config crate). `unread: true` lists instead the variables the scanned env
  files (`.env`, `.env.*`) declare that no code reads (`kind: "unread"`, with
  the env file and line) and the ones code reads that no env file declares
  (`kind: "undeclared"`, with the reading file and line; not `NODE_ENV`, and
  only when some env file exists). Values are never stored.
- `list_data_access({ model?, operation?, library?, direct?, limit = 50 })`:
  lists data-access operations by source, model, library, and operation. Each
  row has the model's `table` when one is known. Go gorm, ent, sqlc,
  `database/sql` and sqlx accesses are included, and Rust sqlx, diesel and
  SeaORM ones (`library: sqlx`, `diesel`, `sea-orm`). Rows with `direct: true`
  (the file or function that makes the call) come first; the others are the
  callers, routes and entrypoints that reach it. `line` is in `accessFile`,
  the file of the call, which differs from the source's `file` on a
  reached-through row. `direct: true` as an argument keeps only the direct
  rows.
- `list_tables({ name?, library?, limit = 20 })`: database tables, views and
  collections from Prisma schema files, TypeORM entities, Mongoose schemas,
  Drizzle table definitions and Knex calls, Go gorm models, ent schemas and
  sqlc queries, Rust diesel `table!` tables, SeaORM entities and sqlx query
  tables, and SQL migrations and schema files (`library: sql` when no
  code declares the table; otherwise the SQL is merged into the code's table
  by name). Each table has its `indexes`, its `migrations` (`file`, `line`,
  `order` — 0 for a schema file — and `change` in run order) and its
  `columns` (with the database `column` name when `@map` renames it, and
  `isId` / `isUnique` / `optional` / `list` flags), the `models` that map to it
  with their `relations` (`field`, `kind` one or many, target `model`,
  `relationName`, `onDelete`), `readBy` / `writtenBy` counts of routes,
  entrypoints and functions, and up to 20 `routes` and `entrypoints` with the
  operations they perform. Answers "which endpoints write the users table?".
- `list_rpcs({ name?, file?, limit = 20 })`: the rpcs of `.proto` files, each
  with its `service`, `file`, `line`, `request` and `response` as written and
  as the `requestMessage` / `responseMessage` they resolve to, `streaming`
  (`client`, `server` or `both`), `servedBy` (the generated Go server
  interface) and `implementations` (every method that implements it, the
  `Unimplemented` stub aside). `name` is a substring of `package.Service/Rpc`.
  An rpc with `servedBy` and no implementations is declared but not
  implemented; one without `servedBy` has no generated Go code in the scan.
- `list_stores({ name?, library?, file?, limit = 20 })`: frontend state stores
  (Pinia, Redux Toolkit, Zustand, Jotai, Svelte), filtered by a substring of
  the name or hook, the `library` or the declaring file. Each store has its
  `kind`, `hook`, `file` and `line`, its `state`, `getters` and `actions`,
  `slices` for a Redux root store (state key → reducer), `definedBy` (the
  setup, creator or atom functions), `readBy` / `writtenBy` counts of
  functions and up to 20 `readers` and `writers` with the `members` they use.
  Answers "what reads the cart store?".

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
  `maxDepth` levels), `stores`: the state stores the change reaches (written
  by an affected function, one of its actions or definitions, or derived from
  such a store; `changedBy` says how) with the functions that read them
  (`readBy`), and `storeComponents` / `storePages`, the components and pages
  those readers (and their callers) reach, and the `dataAccess`, `tables`,
  `envVars` and `config` of the seeds themselves. A store's name or hook as
  `symbol` makes that store the change. For a route, use `route_details`.
  A style, `.class`, `#id` or `--custom-property` as `symbol` (or a style file
  as `file` alone, for every class, id and custom property it declares), asks
  who uses it: `styles`, `users` (components, functions and files naming it,
  with `match` module, import or name), `rules`, `components` (the users and
  the components that render them, with `depth`) and `pages`; a custom
  property also returns the `importers` of the style files that use it.
  With a `symbol`, `unresolvedCalls` and `completeness` say, as in
  `find_callers`, whether calls by the seeds' names are left unresolved.
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
  order (a Go middleware created by a call keeps it as `expression`,
  `auth.Required(true)`), the `callChain` from those functions (up to 4 levels, caller → callee
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
  TanStack Query, Angular `HttpClient`, tRPC, and Go `net/http` and resty), filtered by the route's method, path (resolved full
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
  each way; an Astro island's `client` directive, and the `template` file of
  a render in an Angular `templateUrl`) and `unresolvedRenders` (elements that
  resolved to no component, such as library components). An Angular
  component also has its `selector`.
- `find_component_usages({ name, file?, limit = 50 })`: every `render` of a
  component with that name (`from` is the rendering component, plus the file,
  which is the template file for an Angular `templateUrl`, line and `props`),
  and for a context the functions that read it (`kind:
  "context"`). Elements of that name that resolved to no component, such as
  `<Link>` from a library, are listed with `resolved: false` unless `file` is
  given. `counts` sums the usages by kind.

`file` arguments accept the scan-relative path, a directory (`src/users`,
with or without a trailing slash) or a path suffix of either
(`users/service.ts` matches `src/users/service.ts`). `get_file_outline`
needs one file. When a `file` filter matches no scanned file, list tools
return a `note` saying so instead of an empty list alone.

Example:

```json
{ "name": "impact_of", "arguments": { "symbol": "UserService", "maxDepth": 3 } }
```

### Search and analysis tools

`search_symbols`, `find_definitions` and `list_exports` take two optional
filters on the file that declares the symbol: `sourceType` (`production`,
`test`, `fixture`, `support`, `generated` or `docs`; any other value is an
error) and `language` (the file's `language`, such as `typescript`, `go` or
`python`; case-insensitive; an unknown language matches nothing). Both may be
combined with each other and with `file` and `kind`. The echoed `query` shows
the filters used. `find_references` and `find_callers` have no such filter:
they list use sites, so a filter would have to choose between the
declaration's file and each caller's file, and their results already carry
the file of every site; the tool list has no room for the extra properties
either (it stays under 19 000 characters).

- `search_symbols({ query, kind?, file?, sourceType?, language?, limit = 20 })`: fuzzy search over
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
  - `extends`, `implements` and `injects` for classes and interfaces (Go
    structs too: fx and wire providers).
  - for a style, `.class`, `#id` or `--custom-property` as `symbol`: `rule`
    (a rule whose selector holds it) and `component-use`, `function-use`,
    `file-use` and `var` uses with the `match` kind in `detail`; name matches
    from a sheet the file does not import are `possible: true`.
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
  candidate dead code in JavaScript, TypeScript and Go files. `file` is a file,
  a directory (`packages/common/utils`) or a path suffix of either.
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
  - Go is judged by package (a directory): an exported, capitalized name is
    used when a function of another package calls it or another package's Go
    file mentions the name (read from disk; this covers types, variables and
    functions passed as values). Package `main` and `init` are skipped
    (`skipped.goMain`), and a Go `deadFunctions` entry is an unexported
    function whose name its package's files mention only once.
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
