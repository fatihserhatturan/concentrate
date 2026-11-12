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
| Routes | express, fastify, nestjs-starter, internet-node-express-realworld, internet-nextjs-taxonomy, internet-sveltekit-realworld, internet-go-gin-realworld, internet-go-echo-realworld, internet-go-clean-arch, internet-go-simplebank, internet-go-chi-base, internet-rust-axum-realworld, internet-rust-actix-diesel-realworld, internet-python-flask-realworld, internet-python-fastapi-realworld, internet-python-django-realworld | every route declared with a literal path in the scoped files; tests excluded; for the gin sample, the groups that register functions receive from `main` (`users.UsersRegister(v1.Group("/users"))`); for the echo sample, the `*echo.Echo` that `router.New()` in another package returns, grouped in `main` and passed to `(*Handler).Register`; for simplebank, gin's `router.Group("/").Use(mw)` and the grpc-gateway `http.ServeMux` mounts in `main.go`; for go-base, chi `Mount` / `Route` / `Group` across packages; for the Rust sample, the four axum `router()` functions of `src/http` merged by `api_router` (19 method-path pairs), for the Python samples the Conduit backends (Flask blueprints with absolute paths, FastAPI routers composed through `include_router` and `settings.api_prefix`, DRF `url()` patterns, one router registration and class-based views, 19 method-path pairs each), and for the actix-web sample the nested `web::scope` tree of `src/app/drivers/routes.rs` whose verbs are imported bare (`get().to(h)`, 20 pairs; Rocket and warp are covered by the fixtures only) |
| Calls | express, fastify, nestjs-starter, ky, internet-node-express-realworld, internet-vue-realworld, internet-sveltekit-realworld, internet-angular-realworld, internet-go-gin-realworld (the Conduit Go backend: gin, gorm, packages `users`, `articles`, `common`), internet-go-echo-realworld (another Conduit Go backend: echo, gorm behind store interfaces, packages `handler`, `store`, `model`, `router`, `db`, `utils`), internet-go-clean-arch (echo + database/sql, repository → service → handler layers joined by interfaces), internet-go-simplebank (gin, gRPC, sqlc on pgx, asynq), internet-rust-axum-realworld (a Conduit Rust backend: axum, sqlx; one library crate and a bin), internet-c-cjson (C: the two programs that exercise cJSON), internet-cpp-tinyxml2 (C++: the program that derives from `XMLPrinter`), internet-python-flask-realworld (Flask, Flask-SQLAlchemy; the whole `conduit/` package), internet-python-fastapi-realworld (FastAPI, pydantic, repositories; `app/api/` and `app/services/`) | every call site in 2–9 chosen files per sample; for the Go samples, every call of a repository function or method in their production files (13 gin, 21 echo, 11 clean-arch; echo's generated `docs/docs.go` excluded), and 12 chosen files of simplebank (`main.go`, `api/`, the `db/sqlc` transactions, two `gapi` RPCs, a worker task) |
| Data access | internet-node-express-realworld, internet-nest (05-sql-typeorm, 06-mongoose, 13-mongo-typeorm, 14-mongoose-base, 22-graphql-prisma), internet-go-gin-realworld (gorm), internet-go-echo-realworld (gorm), internet-go-clean-arch (database/sql, MySQL), internet-go-simplebank (sqlc), internet-go-chi-base (bun), internet-rust-axum-realworld (sqlx), internet-rust-actix-diesel-realworld (diesel), internet-python-django-realworld (Django ORM), internet-python-flask-realworld (Flask-SQLAlchemy), internet-python-fastapi-template (SQLModel, Alembic) | the services; for the Go samples the production files that query the database, for the Rust sample the sqlx queries of `src/http` (labeled from their SQL, data-modifying CTEs included; the diesel sample's labels are the tables each `entities.rs` / `repositories.rs` function reads or writes, query-building helpers included only when they name a table; SeaORM is covered by the fixtures only; for the Python samples every `Model.objects…` / `Model.query…` / `session…` access of a function, the CRUD-mixin `save` / `delete` of the Flask sample being unlabeled because they act on any model, and the raw `op.execute` SQL of the template's Alembic revision); the standing samples have no data layer |
| Components, renders | internet-react-realworld (the RealWorld "Conduit" React + Redux frontend), internet-vue-realworld (the Conduit Vue 3 frontend: `<script setup>`, Vue Router, Pinia), internet-sveltekit-realworld (the official SvelteKit Conduit app: Svelte 5, form actions, server `load` functions), internet-angular-realworld (the Conduit Angular frontend: standalone components, `templateUrl` templates, signals, constructor injection) | `src/components/` (React); every `.vue` / `.svelte` file under `src/` (Vue, Svelte); every `@Component` class under `src/` (Angular): every component and every element that renders one |
| Pages | internet-nextjs-taxonomy (shadcn's Next.js 13 App Router app), internet-vue-realworld, internet-sveltekit-realworld, internet-angular-realworld | `app/` and `pages/`: every page, layout, loading and not-found file (Next.js); every route record in `src/router.ts` (Vue); every `+page`, `+layout` and `+error` `.svelte` file under `src/routes/` (SvelteKit); every route object of the Angular Router arrays, lazy `loadChildren` arrays mounted under their parent (Angular) |
| Requests | internet-realworld-fullstack (the RealWorld Express backend and a Next.js + SWR frontend, scanned as one project), internet-realworld-go-fullstack (the same frontend with the gin backend), internet-realworld-rust-fullstack (the same frontend with the axum backend) | `frontend/`: every HTTP call that reaches a backend route; the Go pair's labels are the Express pair's, with each route's declaring file moved to the gin `routers.go` that registers it; the Rust pair's labels are the Go pair's, with each route the axum `.route(..)` registration that serves it; the three Python pairs (internet-realworld-python-{django,flask,fastapi}-fullstack) use the same frontend with a Conduit backend each, labeled with the route declaration that serves each call (Django has no `DELETE /api/articles/:slug`, so that call is not labeled there) |
| Env reads | internet-go-gin-realworld, internet-go-echo-realworld, internet-go-clean-arch, internet-go-simplebank, internet-go-chi-base, internet-rust-axum-realworld, internet-rust-actix-diesel-realworld, internet-python-django-realworld, internet-python-flask-realworld, internet-python-fastapi-realworld | every env read in the production and test files: `os.Getenv` (gin, clean-arch, go-base), viper `Get*` with `AutomaticEnv` (go-base) and the `mapstructure` keys `viper.Unmarshal` fills (simplebank); the echo sample reads none (its secret and database path are constants); for the Python samples `os.environ` reads, Django's `manage.py` and `wsgi.py`, and the pydantic settings fields of the FastAPI sample read as `settings.<field>` (the fields `config()` fills at run time are not labeled) |
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
| internet-rust-actix-diesel-realworld | 20 | 20 | 0 | 0 | 100.0% | 100.0% | 100.0% (20/20) |
| internet-rust-axum-realworld | 19 | 19 | 0 | 0 | 100.0% | 100.0% | 100.0% (19/19) |
| internet-sveltekit-realworld | 11 | 11 | 0 | 0 | 100.0% | 100.0% | 100.0% (11/11) |
| nestjs-starter | 1 | 1 | 0 | 0 | 100.0% | 100.0% | 100.0% (1/1) |
| **all** | 232 | 232 | 0 | 0 | **100.0%** | **100.0%** | **100.0% (232/232)** |

### Call resolution

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 28 | 28 | 0 | 0 | 100.0% | 100.0% |
| fastify | 6 | 6 | 0 | 0 | 100.0% | 100.0% |
| internet-angular-realworld | 21 | 21 | 0 | 0 | 100.0% | 100.0% |
| internet-c-cjson | 110 | 110 | 0 | 0 | 100.0% | 100.0% |
| internet-cpp-tinyxml2 | 9 | 9 | 0 | 0 | 100.0% | 100.0% |
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
| **all** | 854 | 840 | 0 | 14 | **100.0%** | **98.4%** |

The C and C++ samples are labeled from the source too. cJSON: every call of
`test.c` and `tests/readme_examples.c` whose callee is a function of the repository
(a `cJSON_*` function is labeled with its definition in `cJSON.c`, not the
prototype in `cJSON.h`; `tests/common.h` includes `../cJSON.c`, so the static
`compare_double` is visible to the test programs; the Unity assertion macros are
labeled with their `#define`), 110 targets; calls into the C library are not
labeled, so any target they get would count as a false positive. tinyxml2: the
nine calls of `contrib/html5-printer.cpp` (a derived `XMLPrinterHTML5`, a field of
a base class, an explicit call of the base implementation, methods declared in
`tinyxml2.h` and defined in `tinyxml2.cpp`). The C++ scope is small; beyond the
labels, 642 of the 691 call sites of `tinyxml2.cpp` resolve (92.9%; the rest are C
library calls and macros the platform `#if` branches define, see
`docs/known-limitations.md#c-and-c`).

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
| internet-rust-actix-diesel-realworld | 48 | 48 | 0 | 0 | 100.0% | 100.0% |
| internet-rust-axum-realworld | 49 | 49 | 0 | 0 | 100.0% | 100.0% |
| **all** | 288 | 288 | 0 | 0 | **100.0%** | **100.0%** |

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
| internet-realworld-rust-fullstack | 33 | 33 | 0 | 0 | 100.0% | 100.0% |
| **all** | 99 | 99 | 0 | 0 | **100.0%** | **100.0%** |

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
| internet-rust-actix-diesel-realworld | 3 | 3 | 0 | 0 | 100.0% | 100.0% |
| internet-rust-axum-realworld | 2 | 2 | 0 | 0 | 100.0% | 100.0% |
| **all** | 51 | 51 | 0 | 0 | **100.0%** | **100.0%** |

Struct-tag config (`env:"…"`, envconfig) and `os.ExpandEnv` are covered by
`fixtures/go-env` and its golden graph only; the samples read env with
`os.Getenv` and viper. The Rust sample's two reads are clap `#[clap(long, env)]`
fields of `Config`; `std::env::var`, `env!`, envy and the config crate are
covered by `fixtures/rust-env` and its golden graph only. The actix-diesel sample's three reads are `env::var(env_key::X)` with the keys declared as constants in another file, resolved across files. Calls are not labeled for that sample: its handlers reach the use cases through `state.di_container.<usecase>` fields of `Arc<dyn Trait>`, which the scan does not type (a known limitation, see `docs/known-limitations.md`).

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

## Python (Phase 30)

Call resolution is measured on two labeled samples in Phase 33 (see
[Python samples](#python-samples-phase-33)). Before that, this is what was
checked:

- The installed `pip`, `anyio`, `pydantic` and `click` packages of a Python 3.14
  site-packages, scanned as one project (no failed files, no syntax warnings):
  31,835 calls, 9,428 resolved (29.6%). The rest are builtins (`len`, `str`),
  methods of builtin types, library calls outside the scan, and calls on untyped
  parameters; none of them is guessed.
- 40 resolved calls were drawn with a fixed seed and 6 of them read against the
  code (`self.method`, `super().convert`, `op.serialize()` with `op: Op`,
  a class constructor, an aliased module function, a method through an annotated
  parameter): all 6 landed on the right function. This is a spot check, not a
  measurement.
- Fixtures `python-calls`, `python-declarations`, `python-unused` and
  `python-project` pin every resolution rule with golden graphs and tests.

## Python routes (Phase 31)

Three Conduit backends are labeled by hand, one per framework, from their source
and not from the tool's output (`bench/labels/internet-python-*-realworld.json`);
the latest run is in
[`bench/results/accuracy-python-0.1.0-2026-11-11.json`](../bench/results/accuracy-python-0.1.0-2026-11-11.json).

| Sample | Labels | TP | FP | FN | Precision | Recall | Full path |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-python-flask-realworld | 19 | 19 | 0 | 0 | 100.0% | 100.0% | 100.0% (19/19) |
| internet-python-fastapi-realworld | 19 | 19 | 0 | 0 | 100.0% | 100.0% | 100.0% (19/19) |
| internet-python-django-realworld | 19 | 19 | 0 | 0 | 100.0% | 100.0% | 100.0% (19/19) |

What the three samples exercise, and what they do not:

- Flask: blueprints with absolute paths, `register_blueprint` in a function
  (`register_blueprints(app)`), `methods=('GET',)` tuples.
- FastAPI: three levels of `include_router(prefix=..)` (articles are
  `api.py` → `articles/api.py` → resource files), empty paths (`@router.get("")`),
  a prefix read from `settings.api_prefix` (a class attribute through a function
  `get_app_settings() -> AppSettings` and a local variable), and the dependency
  chain of each handler.
- Django: `url(r'^api/', include('conduit.apps.articles.urls', namespace=..))`
  string includes, `include(router.urls)` with
  `DefaultRouter(trailing_slash=False)` and `lookup_field = 'slug'`,
  `APIView` classes, and generic views (`ListCreateAPIView`,
  `RetrieveUpdateAPIView`, `DestroyAPIView`). The method sets come from the
  base classes, which the labels were written from.
- A fourth sample, `internet-python-fastapi-template` (full-stack-fastapi-template,
  23 routes), is not labeled; all 23 routes have a full path and its
  `Annotated[..., Depends(..)]` aliases resolve across files (`SessionDep`,
  `CurrentUser`). Flask-RESTful, Starlette, Celery, click and typer are covered
  by the fixtures (`python-flask`, `python-starlette`, `python-commands`) only,
  checked against `click` 8.4 and Flask 3.1 installed locally (click's command
  names, Flask's `url_map` for blueprint prefixes and repeated registration).

## Python data access, config and env (Phase 32)

The same four samples are labeled by hand for data access and env reads, from
their source and not from the tool's output (`bench/labels/internet-python-*.json`;
the template, which has no route labels, only has data access). The latest run is
in [`bench/results/accuracy-python-0.1.0-2026-11-11.json`](../bench/results/accuracy-python-0.1.0-2026-11-11.json).

| Sample | Section | Labels | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-python-django-realworld | Data access | 19 | 15 | 0 | 4 | 100.0% | 78.9% |
| internet-python-flask-realworld | Data access | 31 | 27 | 0 | 4 | 100.0% | 87.1% |
| internet-python-fastapi-template | Data access | 31 | 27 | 0 | 4 | 100.0% | 87.1% |
| internet-python-django-realworld | Env reads | 2 | 2 | 0 | 0 | 100.0% | 100.0% |
| internet-python-flask-realworld | Env reads | 2 | 2 | 0 | 0 | 100.0% | 100.0% |
| internet-python-fastapi-realworld | Env reads | 22 | 22 | 0 | 0 | 100.0% | 100.0% |
| **all** | Data access | 81 | 69 | 0 | 12 | **100.0%** | **85.2%** |
| **all** | Env reads | 26 | 26 | 0 | 0 | **100.0%** | **100.0%** |

What is missed is the model of a value the code does not name (all 12 labels):
`self.model(...)` + `save()` in Django's `UserManager`, `instance.save()` and
`instance.profile.save()` of a serializer's `update`, `current_user.profile.save()`
and `article.comments...first().delete()` in Flask, and `session.add(current_user)` /
`session.delete(current_user)` (a `CurrentUser` dependency) and a
`db_user` returned by a helper in the template. The FastAPI Conduit sample's
repositories use aiosql query files and pypika, so it has no data-access labels
(the scan finds no accesses there, which is a gap and not a measurement). Its
env labels include the fields of `self.<field>` in the settings class and
`settings.<field>` of a local bound to `get_app_settings()`; the 14 fields
`config()` fills from `environments[app_env]` at run time are not labeled.
The fixtures `python-sqlalchemy`, `python-django-orm`, `python-env`,
`python-http-clients` and `python-di` pin every rule with golden graphs and
tests. The library behaviors the rules assume were run, not guessed, in a
virtualenv with Flask-SQLAlchemy 3.1.1, SQLModel 0.0.49, pydantic-settings 2.16.2
and Django 6.1.3: Flask-SQLAlchemy's default table name (`BookReview` →
`book_review`, `HTTPServer` → `http_server`), SQLModel's (`SecretAgent` →
`secretagent`), pydantic-settings' `env_prefix` (applied to a plain field and an
inherited one, not to a `validation_alias`), Django's `<app>_<model>` table name,
`Meta.db_table`, the `<model>_set` accessor, `related_name` and the one-to-one
accessor named after the model. The Conduit Django sample's migrations
(`CreateModel`, `AddField`) merge into the tables its models make, which also
confirms the names.

Outbound HTTP has no labeled Python sample: the pinned Python backends make no
requests (frontend → Python backend is measured end to end by the Phase 33
samples). The `python-http-clients` fixture links 11 requests, the TypeScript
`fetch` calls and the Python `requests`, `httpx` and `aiohttp` calls, to the
FastAPI routes they reach.

## Python samples (Phase 33)

Phase 33 completes the Python measurement: call labels for two Conduit
backends and three full-stack samples (the Next.js frontend of the Express, Go
and Rust pairs with a Django, a Flask and a FastAPI backend) for frontend →
Python backend requests. The labels are written from the source, not from the
tool's output (`bench/labels/internet-python-*.json`,
`bench/labels/internet-realworld-python-*-fullstack.json`); every row below is
in [`bench/results/accuracy-0.1.0-2026-11-11.json`](../bench/results/accuracy-0.1.0-2026-11-11.json)
and the Python rows alone in
[`bench/results/accuracy-python-0.1.0-2026-11-11.json`](../bench/results/accuracy-python-0.1.0-2026-11-11.json).
Reproduce with `npm run samples:fetch -- --suite internet` and
`npm run bench:accuracy -- --sample <name>`.

| Sample | Section | Labels | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-python-flask-realworld | Call resolution | 63 | 37 | 0 | 26 | 100.0% | 58.7% |
| internet-python-fastapi-realworld | Call resolution | 80 | 79 | 0 | 1 | 100.0% | 98.8% |
| internet-realworld-python-django-fullstack | API requests | 32 | 32 | 0 | 0 | 100.0% | 100.0% |
| internet-realworld-python-flask-fullstack | API requests | 33 | 33 | 0 | 0 | 100.0% | 100.0% |
| internet-realworld-python-fastapi-fullstack | API requests | 33 | 33 | 0 | 0 | 100.0% | 100.0% |

Together with the route, data-access and env rows of Phases 31 and 32 (57 routes,
100% precision and recall), every `bench:accuracy` section that applies to
Python has a Python row; components, pages and stores have none, as Python has
no UI. Precision is 100% everywhere: nothing the scan links is wrong in these
samples.

- **Calls.** Every call site whose callee name is a function, method or class
  written in the repository was listed with Python's own `ast` module and
  decided by reading the code (Flask: all of `conduit/`, 63 labeled sites; FastAPI:
  `app/api/` and `app/services/`, 80). A call of a class runs its `__init__`; a
  class without one (pydantic models, marshmallow schemas) runs library code and is
  labeled null, so the scan must not link it.
- **FastAPI, 98.8%.** The one miss is `user.check_password(..)` in the login
  route, where `user = await users_repo.get_user_by_email(..)` is typed only by
  the repository method's return annotation behind an `await` inside `try`.
- **Flask, 58.7%.** The 26 misses have three causes, none of them guessed at:
  (1) `Model = db.Model` where `db = SQLAlchemy(model_class=CRUDMixin)`, so
  `article.save()`, `comment.delete()`, `user.update(..)` run `CRUDMixin` in
  `conduit/extensions.py` only through a runtime argument (15 sites);
  (2) methods called on a value from an ORM query chain
  (`Article.query.filter_by(..).first()` then `.favourite(..)`, `.set_password(..)`,
  `.check_password(..)`) or on `current_user.profile` (a `LocalProxy`);
  (3) calls in a class body (`reference_col(..)` in model column definitions).
  `error.to_json()` in the errorhandler is registered for `InvalidUsage` at run time
  and is marked dynamic, not scored.
- **Requests.** The frontend calls are the Rust pair's (same files and lines),
  each labeled with the Python route declaration that serves it, with the path as
  the backend writes it. Flask and Django write parameters as `<slug>` and
  `<int:id>`; a `${…}` URL segment now matches them as it matches `:slug`,
  `[slug]` and `{slug}` (before Phase 33 the Flask and Django pairs linked 14 of
  32–33 requests, none of the parameterised ones; `tests/python-route-requests.test.ts`
  pins it). `<path:rest>` is a catch-all.

## C and C++ build systems (Phase 35)

Two new label kinds measure the build files: **buildTargets** and **includes**
(`bench/labels/internet-c-cjson.json`, `internet-cpp-tinyxml2.json`,
`internet-cpp-googletest.json`; rows in
[`bench/results/accuracy-0.1.0-2026-11-12.json`](../bench/results/accuracy-0.1.0-2026-11-12.json)).
Reproduce with `npm run samples:fetch -- --suite internet` and
`npm run bench:accuracy -- --sample <name>`. The labels were written from the build
files, not from the tool's output: the targets, sources and links of every
`CMakeLists.txt` read by hand, the Makefile ones checked against `make -n -B all`
(run on macOS, so cJSON's shared libraries are `libcjson.dylib.1.7.19`; on Linux
the Makefile names them `.so` and four labeled facts would not match).

**Build targets.** One fact per target (build file, system, name, executable or
library), per source it compiles and per target it links. A sample's `scope` is
its build files; a target the scan finds in them that no label names is a false
positive. Every `if` branch counts except the ones a POSIX GCC/Clang build does
not take (see `docs/known-limitations.md#build-systems-cmake-make-compile_commandsjson`).

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-c-cjson (29 CMake targets in three files, 5 Makefile targets) | 125 | 125 | 0 | 0 | 100.0% | 100.0% |
| internet-cpp-tinyxml2 (CMake library and test, Makefile library and test) | 11 | 11 | 0 | 0 | 100.0% | 100.0% |
| internet-cpp-googletest (`googlemock/CMakeLists.txt`, 26 targets through `cxx_library`, `cxx_test` and `cxx_executable`) | 80 | 76 | 0 | 4 | 100.0% | 95.0% |
| **all** | 216 | 212 | 0 | 4 | **100.0%** | **98.1%** |

- **googletest, 95.0%.** The four misses are the same source,
  `googlemock/src/gmock_main.cc` (the sources of `gmock_main`,
  `gmock_main_no_exception`, `gmock_main_no_rtti` and `shared_gmock_main`): the C++
  grammar fails on it, so it is no `File` node and the target lists it as an
  unresolved argument. The functions are read as CMake runs them: `cxx_test(name libs)`
  calls `cxx_test_with_flags`, which calls `cxx_executable_with_flags`, which calls
  `add_executable` and links `libs` inside a `foreach`. Before functions were
  expanded, googletest had no target at all. The same file's `if (MSVC)` branch lists
  `gtest-all.cc` in `gmock`; the scan skips it, as the POSIX build does.
- **cJSON.** `tests/CMakeLists.txt` creates 21 executables in two `foreach` loops over
  `set(...)` lists, with `unity_setup.c` added only for MSVC (skipped), linked to
  `cjson`, `unity` and, for the utils tests, `cjson_utils`. The Makefile has the
  executable, two static and two shared libraries; the second shared library also
  links `cJSON.o`, as `make -n` shows.
- **Executables run their `main`.** In cJSON 23 of the 24 executable CMake targets
  `RUNS` the `main` entrypoint of their source (the golden graph pins it). The 24th,
  `afl-main`, has none: no function of `fuzzing/afl.c` is a node (a Phase 34 gap in
  that file), so there is no `main` to run.

**Includes.** Every `#include` of the C and C++ files of cJSON (31 files, not its
vendored Unity) and tinyxml2 (4 files), labeled with the scanned file it names (null
for a header outside the scan).

| Sample | Labels (resolved) | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-c-cjson | 73 | 73 | 0 | 0 | 100.0% | 100.0% |
| internet-cpp-tinyxml2 | 3 | 3 | 0 | 0 | 100.0% | 100.0% |

Every quoted include of these samples names a file next to the includer, so they
resolved before Phase 35 and the same 90, 995 and 362 imports (cJSON, tinyxml2,
googletest) resolve now, with 1, 10 and 40 unresolved: the CMake include directories
change nothing here. The includes the CMake paths decide are pinned by the fixtures:
`fixtures/cpp-cmake` (`<core/core.h>` from another library's PUBLIC directory, a
`config/` directory from `include_directories`, `#include APP_CONFIG_HEADER` from
`target_compile_definitions`), and `tests/cpp-build.test.ts` moves the include paths
of `fixtures/cpp-includes` from `compile_commands.json` into CMake and gets the same
resolved includes.

## C and C++ frameworks (Phase 36)

Five samples are pinned as sparse checkouts (`paths` in `scripts/samples.json`: only
the examples of each project) and labeled from their source, not from the tool's
output; rows in the same label files as the other samples. Reproduce with
`npm run samples:fetch -- --suite internet` and
`npm run bench:accuracy -- --sample <name>`.

**Routes.** One label per method at the line of the registration macro or call
(`bench/labels/internet-cpp-crow-examples.json`, `internet-cpp-drogon-examples.json`,
`internet-cpp-httplib-examples.json`).

| Sample | Labels | TP | FP | FN | Precision | Recall | Full path |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-cpp-crow-examples (`CROW_ROUTE`, `CROW_BP_ROUTE` with nested blueprints, `CROW_WEBSOCKET_ROUTE`) | 59 | 59 | 0 | 0 | 100.0% | 100.0% | 100.0% (59/59) |
| internet-cpp-drogon-examples (`registerHandler`, `METHOD_ADD`, `ADD_METHOD_TO`, `ADD_METHOD_VIA_REGEX`, `PATH_ADD`, `WS_PATH_ADD`) | 38 | 38 | 0 | 0 | 100.0% | 100.0% | 100.0% (38/38) |
| internet-cpp-httplib-examples (`svr.Get` … on `Server` and `SSLServer`) | 20 | 20 | 0 | 0 | 100.0% | 100.0% | 100.0% (20/20) |
| **all** | 117 | 117 | 0 | 0 | **100.0%** | **100.0%** | **100.0% (117/117)** |

- **What the labeling found.** Reading Drogon's own `HttpController.h` showed that
  `ADD_METHOD_VIA_REGEX` registers the regular expression as written, with no
  `/<namespace>/<Class>` prefix (the first version of the reader added it); and that
  `PATH_ADD` and the `WS_PATH_ADD` macros of a `WebSocketController` are routes too.
  The httplib labels first missed `svr.Post("/post")` of `server_and_client.cc` (a grep
  that filtered out client variables); the scan had found it, so it showed as a false
  positive until a second pass over every `.Get(` / `.Post(` call added the label.
  Scanning the samples also showed that Drogon's `METHOD_LIST_BEGIN` / `PATH_ADD` macros
  and a file-scope `ABSL_FLAG(…);` made the grammar drop the next declaration (a whole
  gRPC service class, a controller's handlers); they are read as blanks now.
- **Route handlers.** A named handler (`&Ctrl::fn`, `Routes::bind(&Endpoint::fn, this)`,
  `svr.Post("/x", fn)`, Drogon's `Class::fn`) is linked (ROUTE_HANDLED_BY) when its
  function is found; a lambda is the route itself. 23 of the 38 Drogon routes have a
  named handler, all linked (the other 15 are lambdas); the Crow examples and cpp-httplib examples are lambdas.

**Data access.** The SQL of `db.exec`, `db.execAndGet`, `SQLite::Statement` and a
`Statement` member prepared in a constructor's initializer list
(`bench/labels/internet-cpp-sqlitecpp-examples.json`), by function: 7 labels (table
`test` read, created and updated by `main` of both examples, read by the
`Example` constructor), 7 found, no false positive. The first version missed the
initializer-list `mQuery(mDb, "SELECT …")` (6 of 7, 85.7%); the member is read now.

**Rpcs.** The rpcs of `helloworld.proto` and `route_guide.proto` and the methods that
implement them (`bench/labels/internet-cpp-grpc-examples.json`): 7 labels, 7 found
(5 sync and callback servers, with `greeter_async_server.cc` implementing none by
design, see `docs/known-limitations.md#c-and-c`).

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-cpp-sqlitecpp-examples (data access) | 7 | 7 | 0 | 0 | 100.0% | 100.0% |
| internet-cpp-grpc-examples (rpcs) | 7 | 7 | 0 | 0 | 100.0% | 100.0% |

**Checked but not labeled.** Three label kinds do not exist for these, so they are
measured as counts against an independent grep, not as precision and recall:

- **libcurl** (`internet-c-curl-examples`, curl's `docs/examples`): of the 104 files that
  call `curl_easy_perform`, 45 set an HTTP(S) or scheme-less literal `CURLOPT_URL` (a grep);
  every one of them has a request with that URL, and the method of
  `CURLOPT_POSTFIELDS`, `CURLOPT_CUSTOMREQUEST` and `CURLOPT_UPLOAD`. 43 more name an
  FTP, IMAP, POP3, SMTP, SFTP, RTSP, WebSocket or file URL (not a request to a route) and
  16 take the URL from `argv` or a variable the function does not assign. Files that only
  use the multi interface (`curl_multi_add_handle`) are read as well (49 files in all).
- **Qt** (`internet-cpp-qt-network-examples`, qtbase's `examples/network` and
  `examples/sql`): 171 `connect(` texts, 36 of them signal-to-slot connections between
  classes of the sample (SIGNAL_CONNECTS_TO) and 134 resolved to their slot; spot-checked by
  reading the 11 connections of `network-chat`'s `chatdialog.cpp` and `client.cpp`: the 10
  whose slot is in the sample resolve to the right slot (the other connects to Qt's own
  `deleteLater`), and the 7 whose signal the sample declares have SIGNAL_CONNECTS_TO. The examples' SQL (`QSqlQuery::exec`) is read too.
- **REQUESTS to routes.** The three client libraries are linked to routes in
  `fixtures/cpp-clients` (7 requests, each to the route with the right method and path),
  which is the golden; no pinned sample has a C++ client and server of its own.

**Cost.** Median scan time of three runs, one process, 2 workers, this change against
`main`: cJSON 180 → 186 ms, tinyxml2 1,082 → 1,096 ms, googletest 1,180 → 1,231 ms (the
plugins read each file's text once; about 3 to 4%). The graphs of cJSON and tinyxml2 are
unchanged (the sample goldens pass).

## C and C++ samples (Phase 37)

`npm run bench:accuracy` now has C and C++ rows in every section that applies
(routes, calls, data access, requests, env reads, rpcs, build targets, includes).
Latest run:
[`bench/results/accuracy-cpp-0.1.0-2026-11-12.json`](../bench/results/accuracy-cpp-0.1.0-2026-11-12.json).
The labels were written from the pinned sources (Crow, Drogon, cpp-httplib,
SQLiteCpp, gRPC C++, Qt SQL and googletest sparse checkouts of `scripts/samples.json`,
plus cJSON and tinyxml2 from Phase 34), not from Concentrate output. Routes were counted
independently with grep over each framework's registration macros and calls; build targets
were expanded by hand from the CMake files and Makefiles; the in-repository call sites
were found by searching every function name defined in the labeled files.

| Kind | Samples | Labels | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Routes | Crow, Drogon, cpp-httplib examples | 118 | 117 | 0 | 1 | 100% | 99.2% |
| Calls | cJSON, tinyxml2, gRPC route_guide and helloworld | 192 | 188 | 0 | 4 | 100% | 97.9% |
| Data access | SQLiteCpp, Qt SQL examples | 26 | 21 | 0 | 5 | 100% | 80.8% |
| Requests | cpp-httplib examples | 2 | 2 | 0 | 0 | 100% | 100% |
| Env reads | googletest | 7 | 3 | 4 | 4 | 42.9% | 42.9% |
| Rpcs | gRPC examples (10 rpcs in 5 services, with the C++ methods that implement them) | 10 | 10 | 0 | 0 | 100% | 100% |
| Build targets | cJSON, tinyxml2, Crow, Drogon, SQLiteCpp, gRPC (CMake and Make) | 317 | 311 | 0 | 6 | 100% | 98.1% |
| Includes | cJSON, tinyxml2, Drogon, gRPC | 95 | 95 | 0 | 0 | 100% | 100% |

The other ecosystems' rows did not move (the totals of every non-C/C++ section are
the same as before the phase; the new rows only add to them).

### What the misses are

- **googletest env (4 FP, 4 FN, the only precision below 100%).** The reads are found
  (`posix::GetEnv`, with literal names and constants such as `kTestTotalShards`) but four of
  them sit in functions of `gtest.cc` that the graph has no node for, so they are attributed to
  the file instead of the function (`ShouldUseColor`, `UnitTest::Run`,
  `PrettyUnitTestResultPrinter::OnTestIterationStart`, `WriteToShardStatusFileIfNeeded`) and
  count as one false positive and one false negative each. The cause is the C++ parser, not the env
  reader: `gtest.cc` (6,900 lines, heavy in unknown macros such as thread-safety annotations
  after a declarator, `__try` / `__except` and `->*` calls) leaves 23 statements out, and the scan warning lists line 397, the
  `namespace testing {` itself, so the file keeps 5 of its functions. Reading unknown macros better is a follow-up (see
  [known limitations](known-limitations.md#c-and-c)).
- **Qt data access (5 FN).** `QSqlQueryModel::setQuery("select * from person")` (2) and
  `QSqlTableModel::setTable("person")` with a literal table (3) are reads of a table; only
  `QSqlQuery::exec` / `prepare` are read.
- **Calls (4 FN).** `GetFeatureName` and `GetDistance` called in
  `route_guide_callback_server.cc` (lines 102, 122, 204, 208) inside a call argument or a
  reactor class are not resolved, while the same calls in `route_guide_server.cc` are.
- **Routes (1 FN).** `CROW_CATCHALL_ROUTE(app)` (a route for every unmatched path) has no
  path to give.
- **Build targets (6 FN).** Crow's `example_vs` (declared inside `if(MSVC)`; the labels count
  every `if` branch) and Drogon's `redis_chat` (an `add_executable(${PROJECT_NAME} …)` after
  several `if` branches) are missing: the target, its source and its link for `example_vs`,
  the target and two sources for `redis_chat`. Why is not found yet.

### Fixes made while labeling

- A client call links to the route of its own program when several programs of one
  repository register the same path (the cpp-httplib examples all have `/hi` and
  `/post`): 0 of 2 before, 2 of 2 after. The tie-break (same file) applies to every
  language and changed no other sample.
- googletest's `posix::GetEnv` wrapper is an env read (the name may be namespaced).
- `GTEST_DEFINE_bool_(…)`-style flags (a prefix and a trailing underscore) and a statement macro at
  column 0 without a `;` (`GTEST_REPEATER_METHOD_(OnTestStart, TestInfo)`) are read as
  blanks; googletest's left-out statements fell from 38 to 23.

