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
[`bench/results/accuracy-0.1.0-2026-11-03.json`](../bench/results/accuracy-0.1.0-2026-11-03.json).

## Labels

The labels are in [`bench/labels/<sample>.json`](../bench/labels). They were
written by reading each sample's source, not derived from Concentrate's
output, so the tool is not graded against itself. Call sites were listed from
the bare tree-sitter syntax tree (every call and `new` expression in the
chosen files); every target was decided by reading the code.

| Kind | Samples | Scope |
| --- | --- | --- |
| Routes | express, fastify, nestjs-starter, internet-node-express-realworld, internet-nextjs-taxonomy, internet-sveltekit-realworld, internet-go-gin-realworld | every route declared with a literal path in the scoped files; tests excluded; for the Go sample, the gin groups that register functions receive from `main` (`users.UsersRegister(v1.Group("/users"))`) |
| Calls | express, fastify, nestjs-starter, ky, internet-node-express-realworld, internet-vue-realworld, internet-sveltekit-realworld, internet-angular-realworld, internet-go-gin-realworld (the Conduit Go backend: gin, gorm, packages `users`, `articles`, `common`) | every call site in 2–9 chosen files per sample; for the Go sample, every call of a repository function or method in its 13 production files |
| Data access | internet-node-express-realworld, internet-nest (05-sql-typeorm, 06-mongoose, 13-mongo-typeorm, 14-mongoose-base, 22-graphql-prisma), internet-go-gin-realworld (gorm) | the services; for the Go sample the production files that query the database; the standing samples have no data layer |
| Components, renders | internet-react-realworld (the RealWorld "Conduit" React + Redux frontend), internet-vue-realworld (the Conduit Vue 3 frontend: `<script setup>`, Vue Router, Pinia), internet-sveltekit-realworld (the official SvelteKit Conduit app: Svelte 5, form actions, server `load` functions), internet-angular-realworld (the Conduit Angular frontend: standalone components, `templateUrl` templates, signals, constructor injection) | `src/components/` (React); every `.vue` / `.svelte` file under `src/` (Vue, Svelte); every `@Component` class under `src/` (Angular): every component and every element that renders one |
| Pages | internet-nextjs-taxonomy (shadcn's Next.js 13 App Router app), internet-vue-realworld, internet-sveltekit-realworld, internet-angular-realworld | `app/` and `pages/`: every page, layout, loading and not-found file (Next.js); every route record in `src/router.ts` (Vue); every `+page`, `+layout` and `+error` `.svelte` file under `src/routes/` (SvelteKit); every route object of the Angular Router arrays, lazy `loadChildren` arrays mounted under their parent (Angular) |
| Requests | internet-realworld-fullstack (the RealWorld Express backend and a Next.js + SWR frontend, scanned as one project) | `frontend/`: every HTTP call that reaches a backend route |
| Env reads | internet-go-gin-realworld | every env read in the production and test files (`os.Getenv`) |
| Stores, store reads and writes | internet-vue-realworld (its Pinia setup store) | `src/`: every store and every call of a store's hook, tests included |

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
  package or built-in code or a callback parameter. Call sites whose target
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
  names no model and is not labeled.
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

## Scoring

- **Routes:** a route is detected when method, file and line (±1) match.
  Detection gives precision and recall; *full path* is the share of detected
  routes whose full path also matches, so a lost mount prefix does not count
  as a missed route.
- **Calls:** a labeled call is a TP when it resolves to the labeled target.
  It is an FN when the labeled target is missed (unresolved, wrong, or no call
  node). An FP is a resolution that should not be there: a wrong target, a
  target for a call labeled `null`, or a resolved call at a site the labels
  do not have. Unresolved calls labeled `null` count for neither, so recall
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

## Results (2026-11-03, schema 65)

### Routes

| Sample | Labels | TP | FP | FN | Precision | Recall | Full path |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 59 | 59 | 0 | 0 | 100.0% | 100.0% | 100.0% (59/59) |
| fastify | 14 | 14 | 0 | 0 | 100.0% | 100.0% | 100.0% (14/14) |
| internet-nextjs-taxonomy | 9 | 9 | 0 | 0 | 100.0% | 100.0% | 100.0% (9/9) |
| internet-node-express-realworld | 20 | 20 | 0 | 0 | 100.0% | 100.0% | 100.0% (20/20) |
| internet-go-gin-realworld | 27 | 27 | 0 | 0 | 100.0% | 100.0% | 100.0% (27/27) |
| internet-sveltekit-realworld | 11 | 11 | 0 | 0 | 100.0% | 100.0% | 100.0% (11/11) |
| nestjs-starter | 1 | 1 | 0 | 0 | 100.0% | 100.0% | 100.0% (1/1) |
| **all** | 141 | 141 | 0 | 0 | **100.0%** | **100.0%** | **100.0% (141/141)** |

### Call resolution

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 28 | 28 | 0 | 0 | 100.0% | 100.0% |
| fastify | 6 | 6 | 0 | 0 | 100.0% | 100.0% |
| internet-angular-realworld | 21 | 21 | 0 | 0 | 100.0% | 100.0% |
| internet-go-gin-realworld | 223 | 223 | 0 | 0 | 100.0% | 100.0% |
| internet-node-express-realworld | 24 | 24 | 0 | 0 | 100.0% | 100.0% |
| internet-sveltekit-realworld | 17 | 17 | 0 | 0 | 100.0% | 100.0% |
| internet-vue-realworld | 14 | 14 | 0 | 0 | 100.0% | 100.0% |
| ky | 13 | 13 | 0 | 0 | 100.0% | 100.0% |
| nestjs-starter | 2 | 2 | 0 | 0 | 100.0% | 100.0% |
| **all** | 348 | 348 | 0 | 0 | **100.0%** | **100.0%** |

Labels counts calls with a project target. Another 433 call sites are labeled
`null`, and 35 are `dynamic`. The Go sample labels only calls with a
project target: a call into the standard library, gin or gorm that resolved
anywhere would count as a false positive (call site not labeled).

### Data access

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-go-gin-realworld | 41 | 41 | 0 | 0 | 100.0% | 100.0% |
| internet-nest | 17 | 17 | 0 | 0 | 100.0% | 100.0% |
| internet-node-express-realworld | 26 | 26 | 0 | 0 | 100.0% | 100.0% |
| **all** | 84 | 84 | 0 | 0 | **100.0%** | **100.0%** |

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

### Stores

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-vue-realworld | 1 | 1 | 0 | 0 | 100.0% | 100.0% |

### Store reads and writes

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-vue-realworld | 11 | 11 | 0 | 0 | 100.0% | 100.0% |

Only one standing sample uses a store library, so these two tables are
small: Redux Toolkit, Zustand, Jotai and Svelte stores are covered by their
fixtures and golden queries (`fixtures/redux-toolkit`, `zustand-stores`,
`jotai-atoms`, `svelte-stores`), not by labels on a real repository. The
React RealWorld sample uses `connect()` with hand-written reducers, which is
not a Redux Toolkit store.

### Env reads

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-go-gin-realworld | 6 | 6 | 0 | 0 | 100.0% | 100.0% |
| **all** | 6 | 6 | 0 | 0 | **100.0%** | **100.0%** |

viper, struct-tag config and `os.ExpandEnv` are covered by `fixtures/go-env`
and its golden graph; the gin sample reads env with `os.Getenv` only.

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

The same list, by area, is in [known-limitations.md](known-limitations.md).

## Adding labels

Add a sample's file to `bench/labels/` named after the sample in
`scripts/samples.json`. Label from the source, keep each `scope` (routes,
data access) or `files` list (calls) complete (every route, call or access in
it labeled), and run `npm test`: `tests/bench-accuracy.test.ts` checks that
the entries are complete and, when the samples are fetched, that every named
file exists.
