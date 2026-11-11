# Accuracy report

How often the graph is right about routes, call targets, data access, UI
components, UI pages, frontend → backend requests and state stores with
their reads and writes, measured against hand-written labels on the pinned sample repositories
(`scripts/samples.json`).

```bash
npm run samples:fetch
npm run bench:accuracy -- [--sample name] [--details] [--json out.json]
```

`--details` lists every false positive (FP), false negative (FN) and wrong
route path. The latest run is in
[`bench/results/accuracy-0.1.0-2026-11-05.json`](../bench/results/accuracy-0.1.0-2026-11-05.json).

## Labels

The labels are in [`bench/labels/<sample>.json`](../bench/labels). They were
written by reading each sample's source, not derived from Concentrate's
output, so the tool is not graded against itself. Call sites were listed from
the bare tree-sitter syntax tree (every call and `new` expression in the
chosen files); every target was decided by reading the code.

| Kind | Samples | Scope |
| --- | --- | --- |
| Routes | express, fastify, nestjs-starter, internet-node-express-realworld, internet-nextjs-taxonomy, internet-sveltekit-realworld, internet-go-gin-realworld, internet-go-echo-realworld, internet-go-clean-arch, internet-go-simplebank, internet-go-chi-base, internet-rust-axum-realworld | every route declared with a literal path in the scoped files; tests excluded; for the gin sample, the groups that register functions receive from `main` (`users.UsersRegister(v1.Group("/users"))`); for the echo sample, the `*echo.Echo` that `router.New()` in another package returns, grouped in `main` and passed to `(*Handler).Register`; for simplebank, gin's `router.Group("/").Use(mw)` and the grpc-gateway `http.ServeMux` mounts in `main.go`; for go-base, chi `Mount` / `Route` / `Group` across packages; for the Rust sample, the four axum `router()` functions of `src/http` merged by `api_router` (19 method-path pairs; one small sample, so the recall says little about actix-web, Rocket or warp, which the fixtures cover only) |
| Calls | express, fastify, nestjs-starter, ky, internet-node-express-realworld, internet-vue-realworld, internet-sveltekit-realworld, internet-angular-realworld, internet-go-gin-realworld (the Conduit Go backend: gin, gorm, packages `users`, `articles`, `common`), internet-go-echo-realworld (another Conduit Go backend: echo, gorm behind store interfaces, packages `handler`, `store`, `model`, `router`, `db`, `utils`), internet-go-clean-arch (echo + database/sql, repository → service → handler layers joined by interfaces), internet-go-simplebank (gin, gRPC, sqlc on pgx, asynq), internet-rust-axum-realworld (a Conduit Rust backend: axum, sqlx; one library crate and a bin) | every call site in 2–9 chosen files per sample; for the Go samples, every call of a repository function or method in their production files (13 gin, 21 echo, 11 clean-arch; echo's generated `docs/docs.go` excluded), and 12 chosen files of simplebank (`main.go`, `api/`, the `db/sqlc` transactions, two `gapi` RPCs, a worker task) |
| Data access | internet-node-express-realworld, internet-nest (05-sql-typeorm, 06-mongoose, 13-mongo-typeorm, 14-mongoose-base, 22-graphql-prisma), internet-go-gin-realworld (gorm), internet-go-echo-realworld (gorm), internet-go-clean-arch (database/sql, MySQL), internet-go-simplebank (sqlc), internet-go-chi-base (bun) | the services; for the Go samples the production files that query the database; the standing samples have no data layer |
| Components, renders | internet-react-realworld (the RealWorld "Conduit" React + Redux frontend), internet-vue-realworld (the Conduit Vue 3 frontend: `<script setup>`, Vue Router, Pinia), internet-sveltekit-realworld (the official SvelteKit Conduit app: Svelte 5, form actions, server `load` functions), internet-angular-realworld (the Conduit Angular frontend: standalone components, `templateUrl` templates, signals, constructor injection) | `src/components/` (React); every `.vue` / `.svelte` file under `src/` (Vue, Svelte); every `@Component` class under `src/` (Angular): every component and every element that renders one |
| Pages | internet-nextjs-taxonomy (shadcn's Next.js 13 App Router app), internet-vue-realworld, internet-sveltekit-realworld, internet-angular-realworld | `app/` and `pages/`: every page, layout, loading and not-found file (Next.js); every route record in `src/router.ts` (Vue); every `+page`, `+layout` and `+error` `.svelte` file under `src/routes/` (SvelteKit); every route object of the Angular Router arrays, lazy `loadChildren` arrays mounted under their parent (Angular) |
| Requests | internet-realworld-fullstack (the RealWorld Express backend and a Next.js + SWR frontend, scanned as one project), internet-realworld-go-fullstack (the same frontend with the gin backend) | `frontend/`: every HTTP call that reaches a backend route; the Go pair's labels are the Express pair's, with each route's declaring file moved to the gin `routers.go` that registers it |
| Env reads | internet-go-gin-realworld, internet-go-echo-realworld, internet-go-clean-arch, internet-go-simplebank, internet-go-chi-base | every env read in the production and test files: `os.Getenv` (gin, clean-arch, go-base), viper `Get*` with `AutomaticEnv` (go-base) and the `mapstructure` keys `viper.Unmarshal` fills (simplebank); the echo sample reads none (its secret and database path are constants) |
| Stores, store reads and writes | internet-vue-realworld (its Pinia setup store) | `src/`: every store and every call of a store's hook, tests included |
| Scripts, what they run, env declarations | internet-node-express-firebase-mongodb (root `package.json`, `Dockerfile`, `docker-compose.yml`, `.github/`), internet-go-simplebank (`Makefile`, `Dockerfile`, `docker-compose.yaml`, `start.sh`, `wait-for.sh`, `eks/`, `.github/`; the Vue `frontend/` is not labeled) | every package.json script, Makefile target, shell script, Dockerfile `CMD` / `ENTRYPOINT`, compose service and CI job; what each runs; every env variable they declare. Labeled from the files, before the tool was run on them (see the results) |

Rules:

- **Routes.** `{ method, path, file, line }` with the full path, mount
  prefixes included. Middleware mounts (`app.use`) are not routes. Express
  examples that build paths at runtime (`examples/resource`,
  `examples/route-map`, `examples/mvc`) are listed under `routes.computed` in
  the label file and not scored; since #146 the graph records each of their
  registration lines in `File.dynamicRouteCalls`, which `list_routes`
  returns. Next.js route handlers are labeled at the
  exported `GET` / `POST` / ... function, with Next's path syntax
  (`/api/posts/[postId]`); a `pages/api/` handler is method `ALL`, at its
  `export default` line when that is a library call (`NextAuth(options)`).
  `app/api/auth/[...nextauth]/_route.ts` is not a route file (Next only
  serves files named `route`), so its handlers are not labeled.
  SvelteKit form actions are POST routes at the page's path, `?/name` for a
  named action (`/article/[slug]?/createComment`), labeled at the action's
  function.
- **Calls.** `{ file, line, callee, target }`, where `callee` is the called
  name (the last member, or the class of `new X`). `target` is the project
  declaration the call runs (`{ file, name, className? }`; `new X` targets X's
  `constructor`, and the class node also counts) or `null` when it runs
  package or built-in code or a callback parameter. A call that dispatches
  to several functions has `targets` (the list) in place of `target`: a Go
  interface method call is labeled with the method of every type in the
  repository whose method set has the interface's methods with the same
  signatures, mocks included (class hierarchy analysis, what Go itself
  allows). Call sites whose target
  is only known at runtime are marked `dynamic` and not scored: Express's
  `app.get` / `app.post` (generated in a `methods.forEach` loop) and
  `req` / `res` methods (prototypes the framework sets per request).
- **Data access.** `{ file, function, model, operation, table }` once per
  function, model and operation, for calls in the function's own body
  (callers that reach the access through a call are not labeled). Operations
  use the graph's categories (`save` is a create, `findOneBy` a read). Tables
  follow each library's default naming. Nested Prisma relation writes
  (`connectOrCreate` inside an `article.create`) are not labeled. For gorm,
  the models `Preload` paths load are reads and an `Association` call is an
  access of the field's model; `db.Save(data)` with an `interface{}` value
  names no model and is not labeled. For database/sql and sqlc the model is
  the table the SQL names, labeled on the function that holds the SQL, also
  when a helper it passes the SQL to runs it (`m.fetch(ctx, query, id)`).
- **Components.** `{ file, name, line }` for every React component: function
  and class components, including a class that extends another component
  (`ProfileFavorites extends Profile`).
- **Renders.** `{ file, parent, line, child, childFile }` once per JSX
  element that renders a component of the repository. Rendering a module's
  `connect(...)(X)` default export counts as rendering X. Library elements
  (`<Link>`, `<Route>`), components passed as props (`<Route
  component={Home}>`) and elements in class methods other than `render()`
  (which render library components only) are not labeled.
- **Pages.** `{ file, fullPath, kind, component }` for every Next.js special
  file: `kind` is the file's role (`page`, `layout`, `loading`,
  `not-found`), `fullPath` its URL with route groups left out and dynamic
  segments in Next's syntax (`/docs/[[...slug]]`), `component` the name of
  the component it exports as default. Metadata routes (`app/robots.ts`) are
  not pages.
- **Requests.** `{ file, line, route, routeFile }` for every frontend call
  whose URL reaches one backend route: `route` is the route's method and full
  path (`GET /api/articles/:slug`), `routeFile` the file that declares it.
  The frontend calls the deployed API (`https://conduit.productionready.io/api`),
  which the sample declares in `apiOrigins` (`--api-origin` on the CLI). A
  call whose URL is a variable reassigned in branches is labeled with the
  route most branches request; calls to the frontend's own origin (`/user`),
  through a wrapper's URL parameter, or to local storage are not labeled.
- **Stores.** `{ file, name, library, kind }` for every store declaration.
  **Store reads and writes:** `{ file, line, store, storeFile, reads,
  writes }` once per use of a store (a `useUserStore()` call), with the
  state, getters and actions it reads (`storeToRefs(useUserStore())`
  destructuring, `userStore.user`, a reference to an action without calling
  it) and the actions and write methods it calls or destructures.
- **Env reads.** `{ file, line, name, function }` once per read of an env
  variable, `function` null outside any function. Writes (`os.Setenv`) are
  not labeled.
- **Scripts.** `{ file, line, kind, trigger }` for each entrypoint of kind
  `npm-script`, `make`, `script`, `docker`, `compose-service` or `ci-job`
  (`trigger` is the script name, the target, the file path, `CMD` or
  `ENTRYPOINT`, the service or the job id). **Runs:** `{ file, kind, trigger,
  target }` once per file or entrypoint a command starts that is in the
  repository; `target` is a file path (a script file is its path) or
  `<file>#<trigger>` for a make target, npm script, compose service or job.
  A command that names a path inside a container (`/app/start.sh`) is read as
  a person reads it, through the Dockerfile's `COPY`. Build outputs
  (`node ./dist/server.cjs`) and tools (`eslint`, `migrate`) are not links.
  **Env declarations:** `{ file, line, name }` for an env variable set by
  `export`, a `NAME=value` before a command, a Dockerfile `ENV` or `ARG`, a
  compose `environment:` or `env_file:`, or an `env:` of a workflow, job,
  step, service container or container; `docker run -e` flags and plain shell
  assignments are not declarations.

## Scoring

- **Routes:** a route is detected when method, file and line (±1) match.
  Detection gives precision and recall; *full path* is the share of detected
  routes whose full path also matches, so a lost mount prefix does not count
  as a missed route.
- **Calls:** each labeled target is scored on its own: a TP when the call
  resolves to it, an FN when the call misses it (unresolved, wrong, or no
  call node). An FP is a resolution that should not be there: a target the
  label does not list, a target for a call labeled `null`, or a resolved
  call at a site the labels do not have. Unresolved calls labeled `null` count for neither, so recall
  is over calls with a project target.
- **Data access:** an access matches on file, function, model and operation,
  and on the table when the label names one.
- **Components:** file, name and line (±1). **Renders:** the element's file,
  line (±1) and component, and the rendered component's name and file; a
  render linked to another component is an FP and an FN.
- **Pages:** file, kind, full path and the rendered component all match; a
  page with the wrong path or component is an FP and an FN.
- **Requests:** the call's file and line (±1), the route and its declaring
  file all match; a call linked to another route is an FP and an FN.
- **Stores:** file, name, library and kind all match. **Store reads and
  writes:** the READS_STORE and WRITES_STORE edges of one function, line and
  store are one use; it matches when file, line (±1), store and its file,
  and both member sets match, so a missed or extra member is an FP and an
  FN.
- **Scripts:** file, kind, trigger and line (±1). **Runs:** file, kind,
  trigger and target. **Env declarations:** file, line and name.
- **SQL tables:** one item per table the SQL files declare (a `Table` with
  migrations, matched by the file that declares it): name, kind and the
  columns in DDL order, each as `name:type` (lower case, as written), then
  `?` when nullable, ` pk`, ` unique` and ` -> table.column`. Any difference
  in a column is an FP and an FN.
- **Proto rpcs:** file, service (`package.Service`), name, request and
  response as written, streaming, the generated Go server interface that
  serves it (or none) and the set of methods that implement it
  (`path#Type.Method`).
- **Class links:** the user's file (a component's or function's declaring
  file), line, the class and the style file it is declared in, and the match
  kind (`module`, `import` or `name`) all match. Only classes the project's
  style sheets declare are labeled; `styles[position]`, `:class="link.icon"`
  and `btn-${size}` are not.

## Results (2026-11-11, schema 77)

### Routes

| Sample | Labels | TP | FP | FN | Precision | Recall | Full path |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 59 | 59 | 0 | 0 | 100.0% | 100.0% | 100.0% (59/59) |
| fastify | 14 | 14 | 0 | 0 | 100.0% | 100.0% | 100.0% (14/14) |
| internet-go-chi-base | 19 | 19 | 0 | 0 | 100.0% | 100.0% | 100.0% (19/19) |
| internet-go-clean-arch | 4 | 4 | 0 | 0 | 100.0% | 100.0% | 100.0% (4/4) |
| internet-go-echo-realworld | 20 | 20 | 0 | 0 | 100.0% | 100.0% | 100.0% (20/20) |
| internet-go-gin-realworld | 27 | 27 | 0 | 0 | 100.0% | 100.0% | 100.0% (27/27) |
| internet-go-simplebank | 9 | 9 | 0 | 0 | 100.0% | 100.0% | 100.0% (9/9) |
| internet-nextjs-taxonomy | 9 | 9 | 0 | 0 | 100.0% | 100.0% | 100.0% (9/9) |
| internet-node-express-realworld | 20 | 20 | 0 | 0 | 100.0% | 100.0% | 100.0% (20/20) |
| internet-rust-axum-realworld | 19 | 19 | 0 | 0 | 100.0% | 100.0% | 100.0% (19/19) |
| internet-sveltekit-realworld | 11 | 11 | 0 | 0 | 100.0% | 100.0% | 100.0% (11/11) |
| nestjs-starter | 1 | 1 | 0 | 0 | 100.0% | 100.0% | 100.0% (1/1) |
| **all** | 212 | 212 | 0 | 0 | **100.0%** | **100.0%** | **100.0% (212/212)** |

### Call resolution

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 28 | 28 | 0 | 0 | 100.0% | 100.0% |
| fastify | 6 | 6 | 0 | 0 | 100.0% | 100.0% |
| internet-angular-realworld | 21 | 21 | 0 | 0 | 100.0% | 100.0% |
| internet-go-clean-arch | 68 | 68 | 0 | 0 | 100.0% | 100.0% |
| internet-go-echo-realworld | 149 | 149 | 0 | 0 | 100.0% | 100.0% |
| internet-go-gin-realworld | 223 | 223 | 0 | 0 | 100.0% | 100.0% |
| internet-go-simplebank | 123 | 123 | 0 | 0 | 100.0% | 100.0% |
| internet-node-express-realworld | 24 | 24 | 0 | 0 | 100.0% | 100.0% |
| internet-rust-axum-realworld | 47 | 33 | 0 | 14 | 100.0% | 70.2% |
| internet-sveltekit-realworld | 17 | 17 | 0 | 0 | 100.0% | 100.0% |
| internet-vue-realworld | 14 | 14 | 0 | 0 | 100.0% | 100.0% |
| ky | 13 | 13 | 0 | 0 | 100.0% | 100.0% |
| nestjs-starter | 2 | 2 | 0 | 0 | 100.0% | 100.0% |
| **all** | 735 | 721 | 0 | 14 | **100.0%** | **98.1%** |

Labels counts calls with a project target. Another 433 call sites are labeled
`null`, and 35 are `dynamic`. The Go samples label only calls with a
project target: a call into the standard library, gin, echo or gorm that resolved
anywhere would count as a false positive (call site not labeled). The Rust sample
is labeled the same way, from the source (every function name defined in `src/`
searched for its call sites). Its 14 misses are call sites the scan does not see or
cannot type: method calls inside macro arguments (`sqlx::query!(…, maybe_auth_user.user_id())`,
`assert_eq!(slugify(…), …)`, 7), `.into_article()` / `.into_comment()` on a sqlx
query chain whose type only the `query_as!` macro names (5), and `to_jwt` on a struct
literal (`AuthUser { user_id }.to_jwt(&ctx)`, 2).

### Data access

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-go-chi-base | 28 | 28 | 0 | 0 | 100.0% | 100.0% |
| internet-go-clean-arch | 7 | 7 | 0 | 0 | 100.0% | 100.0% |
| internet-go-echo-realworld | 52 | 52 | 0 | 0 | 100.0% | 100.0% |
| internet-go-gin-realworld | 41 | 41 | 0 | 0 | 100.0% | 100.0% |
| internet-go-simplebank | 20 | 20 | 0 | 0 | 100.0% | 100.0% |
| internet-nest | 17 | 17 | 0 | 0 | 100.0% | 100.0% |
| internet-node-express-realworld | 26 | 26 | 0 | 0 | 100.0% | 100.0% |
| **all** | 191 | 191 | 0 | 0 | **100.0%** | **100.0%** |

### Components

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-angular-realworld | 18 | 18 | 0 | 0 | 100.0% | 100.0% |
| internet-react-realworld | 32 | 31 | 0 | 1 | 100.0% | 96.9% |
| internet-sveltekit-realworld | 24 | 24 | 0 | 0 | 100.0% | 100.0% |
| internet-vue-realworld | 22 | 22 | 0 | 0 | 100.0% | 100.0% |
| **all** | 96 | 95 | 0 | 1 | **100.0%** | **99.0%** |

### Component renders

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-angular-realworld | 23 | 23 | 0 | 0 | 100.0% | 100.0% |
| internet-react-realworld | 29 | 29 | 0 | 0 | 100.0% | 100.0% |
| internet-sveltekit-realworld | 17 | 17 | 0 | 0 | 100.0% | 100.0% |
| internet-vue-realworld | 33 | 33 | 0 | 0 | 100.0% | 100.0% |
| **all** | 102 | 102 | 0 | 0 | **100.0%** | **100.0%** |

### Pages

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-angular-realworld | 14 | 14 | 0 | 0 | 100.0% | 100.0% |
| internet-nextjs-taxonomy | 27 | 27 | 0 | 0 | 100.0% | 100.0% |
| internet-sveltekit-realworld | 13 | 13 | 0 | 0 | 100.0% | 100.0% |
| internet-vue-realworld | 12 | 12 | 0 | 0 | 100.0% | 100.0% |
| **all** | 66 | 66 | 0 | 0 | **100.0%** | **100.0%** |

### API requests

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-realworld-fullstack | 33 | 33 | 0 | 0 | 100.0% | 100.0% |
| internet-realworld-go-fullstack | 33 | 33 | 0 | 0 | 100.0% | 100.0% |
| **all** | 66 | 66 | 0 | 0 | **100.0%** | **100.0%** |

### Stores

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-vue-realworld | 1 | 1 | 0 | 0 | 100.0% | 100.0% |
| **all** | 1 | 1 | 0 | 0 | **100.0%** | **100.0%** |

### Store reads and writes

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-vue-realworld | 11 | 11 | 0 | 0 | 100.0% | 100.0% |
| **all** | 11 | 11 | 0 | 0 | **100.0%** | **100.0%** |

Only one standing sample uses a store library, so these two tables are
small: Redux Toolkit, Zustand, Jotai and Svelte stores are covered by their
fixtures and golden queries (`fixtures/redux-toolkit`, `zustand-stores`,
`jotai-atoms`, `svelte-stores`), not by labels on a real repository. The
React RealWorld sample uses `connect()` with hand-written reducers, which is
not a Redux Toolkit store.

### Env reads

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-go-chi-base | 20 | 20 | 0 | 0 | 100.0% | 100.0% |
| internet-go-clean-arch | 7 | 7 | 0 | 0 | 100.0% | 100.0% |
| internet-go-echo-realworld | 0 | 0 | 0 | 0 | – | – |
| internet-go-gin-realworld | 6 | 6 | 0 | 0 | 100.0% | 100.0% |
| internet-go-simplebank | 13 | 13 | 0 | 0 | 100.0% | 100.0% |
| **all** | 46 | 46 | 0 | 0 | **100.0%** | **100.0%** |

Struct-tag config (`env:"…"`, envconfig) and `os.ExpandEnv` are covered by
`fixtures/go-env` and its golden graph only; the samples read env with
`os.Getenv` and viper.

### Scripts and infrastructure

| Kind | Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Entrypoints | internet-node-express-firebase-mongodb | 13 | 13 | 0 | 0 | 100.0% | 100.0% |
| Entrypoints | internet-go-simplebank | 29 | 29 | 0 | 0 | 100.0% | 100.0% |
| Runs | internet-node-express-firebase-mongodb | 17 | 17 | 0 | 0 | 100.0% | 100.0% |
| Runs | internet-go-simplebank | 7 | 7 | 0 | 0 | 100.0% | 100.0% |
| Env declarations | internet-node-express-firebase-mongodb | 7 | 7 | 0 | 0 | 100.0% | 100.0% |
| Env declarations | internet-go-simplebank | 11 | 11 | 0 | 0 | 100.0% | 100.0% |

These labels were written from the files first. The first run found three
defects, which were fixed in the tool, not in the labels: before the fixes,
runs recall on simplebank was 57.1% (3 of 7: the container paths
`/app/start.sh` and `/app/wait-for.sh` in the Dockerfile and the compose
`entrypoint:` were not linked), and env declarations had precision 44.4% and
recall 72.7% (10 false positives: `docker run -e NAME=…` arguments in the
Makefile and the plain assignments of `wait-for.sh`, such as
`TIMEOUT=$((TIMEOUT - 1))`, were read as `NAME=value command`; 3 misses: the
`env:` of the workflow's postgres service container). Two samples with a few
dozen labels each: the numbers show that these rules hold on a JS app and a
Go service, not that every Dockerfile, Makefile or workflow is read right.

### SQL tables and proto rpcs

| Kind | Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| SQL tables | internet-go-simplebank | 6 | 6 | 0 | 0 | 100.0% | 100.0% |
| SQL tables | internet-go-clean-arch | 4 | 4 | 0 | 0 | 100.0% | 100.0% |
| Proto rpcs | internet-go-simplebank | 4 | 4 | 0 | 0 | 100.0% | 100.0% |
| Proto rpcs | internet-go-kratos-beer-shop | 17 | 17 | 0 | 0 | 100.0% | 100.0% |

Both were written by reading the files, not from the graph's output: simplebank's
five up migrations (the `ALTER TABLE … ADD FOREIGN KEY` references, the two
columns added later to `users`), the MySQL dump of go-clean-arch (backticks,
`int(11) unsigned`, `COLLATE`, `/*! … */` lines, data and `LOCK TABLES` that
are not DDL), and the `.proto` and `_grpc.pb.go` files with the Go services.
Catalog's `DeleteBeer` is the labeled case of an rpc a generated server
interface declares and no type implements, and `listBeerNextTokenReq` is a
request type spelled with a lower-case first letter in the sample. Neither
set found a defect: these scanners were fixture-tested against the same
kinds of statements first, so 100% says the rules hold on a Go service's
migrations and gRPC code, not that every migration tool or `.proto` layout
is read. Only the services Concentrate resolves through a generated Go
server are labeled; the User, ShopInterface, ShopAdmin and Courier services
of beer-shop are not.

### Class links

| Kind | Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Class links | internet-remark42-frontend | 263 | 263 | 0 | 0 | 100.0% | 100.0% |
| Class links | internet-vue-realworld | 241 | 241 | 0 | 0 | 100.0% | 100.0% |

`internet-remark42-frontend` is remark42's Preact frontend (the same commit
as `internet-go-remark42`, whose smoke entry leaves `frontend/**` out): 259
exact `styles.x` links of 29 CSS Modules files and 4 name matches of global
classes (`raw-content`, `preloader`). `internet-vue-realworld` has no CSS
Modules; its 241 links are the `class` and `:class` literals of the templates
(219 to `public/main.css`, which `index.html` loads by a root-relative
`<link>`, so they are name matches, and 22 to the component's own `<style>`).

These labels were not typed in by hand: each sample was read by a separate
regex pass over the sources (never by Concentrate), and the lines the pass
could not decide were read: the operand of `theme === 'dark'` is not a class,
and a class a component's own `<style>` declares wins over the project
sheet. The first Vue pass scored 90.9% precision, and every false positive
was a defect in the labels (templates cut at a nested `</template>`, the
components' own `<style>` blocks not read), not in the graph. Both passes
read static names only, so they and the graph can agree on a template that
builds names at run time; recall here says the graph finds what a regex
finds, not what a person could infer.

## What the misses are

Precision is 100% everywhere: no route, call target, data access, component,
render, page, request, store or store use the graph states is wrong. (The one wrong call target, a bare `resolve()` bound by `var
resolve = path.resolve` in express's `lib/view.js`, is left unresolved since
#48.) Every labeled route is found: routes registered inside plugin
functions and `build()` factories (#41), fastify-decorators controllers
(#42), and apps and routers recognized by the factory that created them
(`apiv1 = express.Router()`, `main = express()`, #43), Next.js route
handlers, including a `pages/api/` route whose default export is
`NextAuth(options)`, each with its full
path: mount prefixes are followed across files, through chained and
default-exported routers (`export default Router().use('/api', api)`) and
`app.use('/api/v1', require('./api_v1'))` (#44). Recall is where the gaps
are, and they cluster:

- **Objects assembled at runtime (express).** Every express call resolves.
  Express's `app` gets its methods from `lib/application.js` through
  `merge-descriptors`; since #146 `app.set` / `app.use` / `app.listen`
  resolve there through the `createApplication` factory, including the calls
  inside a module-level `if (!module.parent) { … }` block. (Default imports,
  #45; constructors and static methods, #46; and module-level calls,
  `require('./x')(...)` and `module.exports = …` defaults, #47, resolve
  too.)

- **Imported instances (Vue sample).** Every Vue call resolves. The last
  three were calls on an instance created in another module and imported:
  `api.setSecurityData(…)`, where `api` is a `new Api(…)` from
  `src/services` and `setSecurityData` a class field holding an arrow
  function in its base class, and `userStorage.remove()` on a
  `new Storage(…)` instance (#146). The destructured Pinia action
  (`const { updateUser } = useUserStore(); updateUser(…)`) resolves to the
  setup store's function.

- **Component class hierarchies.** The one missed component is
  `ProfileFavorites`, a class that extends another component class
  (`Profile`) instead of `React.Component`. Every labeled render is found:
  renders of `export default connect(...)(X)` modules resolve to X, and in
  the Vue sample `<AppLink>`, which no component imports, resolves through
  the global `app.component('AppLink', AppLink)` registration. Every Vue
  Router record is a page, its lazy `() => import('./pages/Home.vue')`
  linked to the page component. In the SvelteKit sample every component,
  render, page and form action is found, `$lib` imports resolved through
  SvelteKit's default alias. In the Angular sample every component, template
  render (by selector, through each component's `imports`) and Router page
  is found, including the profile routes lazy-loaded with `loadChildren`, and
  calls on constructor-injected services resolve to the service methods.

- **Requests.** Every labeled frontend call links to its route, through
  `SERVER_BASE_URL` template strings, `axios` calls in `lib/api/` and SWR
  keys in components and pages. `components/article/ArticleList.tsx` passes
  `useSWR` a local `fetchURL` that a `switch` reassigns; since #146 the call
  is linked to both routes it can request, `GET /api/articles` and
  `GET /api/articles/feed`.

Every labeled data access is found since #49 (the TypeORM `*By` and Mongoose
`findById*` / `findOneAnd*` methods, and calls on a receiver split over
lines, `this.catModel\n  .findByIdAndUpdate(…)`).

On the Go samples, every labeled route, call target, data access and env
read is found. Labeling go-clean-arch and simplebank found seven gaps, fixed
before the labels were scored (#187): an interface implemented by any type
with a method of the same name (a single-method `AuthorRepository` also
matched `ArticleHandler.GetByID(echo.Context)`), a later `if a, ok := …`
hiding the receiver `a`, the untyped parameter of a closure (`func(q
*Queries) error`), SQL in a local or passed to a helper, MySQL's `INSERT`
without `INTO`, gin's `Group("/").Use(mw)`, and viper's `Unmarshal(&cfg)`.
go-base's data access (bun) is labeled too; its calls are not.

The same list, by area, is in [known-limitations.md](known-limitations.md).

## Adding labels

Add a sample's file to `bench/labels/` named after the sample in
`scripts/samples.json`. Label from the source, keep each `scope` (routes,
data access) or `files` list (calls) complete (every route, call or access in
it labeled), and run `npm test`: `tests/bench-accuracy.test.ts` checks that
the entries are complete and, when the samples are fetched, that every named
file exists.
