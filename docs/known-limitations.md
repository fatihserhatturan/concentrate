# Known Limitations and Semantic Review Backlog

This backlog captures known risk areas before long-term architectural work
begins. It is intentionally practical: each item should either guide semantic
review or feed a future long-term task.

## Import Resolution

- Package and workspace resolution covers common npm, pnpm, yarn, `exports`,
  `main`, `types`, `baseUrl`, and `paths` cases, but does not yet model every
  conditional export branch or runtime-specific resolver rule.
- SvelteKit's `$lib` alias resolves to `src/lib` when the root package
  depends on `@sveltejs/kit` and the paths do not map `$lib` (its generated
  `.svelte-kit/tsconfig.json` is usually not checked in); `kit.alias` from
  `svelte.config.js` and `$lib` in workspace packages are not read.
- Dynamic imports with non-literal specifiers are represented as imports only
  when a literal source is visible.
- Cross-language imports are not semantically resolved beyond the language
  families already supported.

Blocks or informs: incremental scanning invalidation, MCP `find_definitions`,
and deeper package graph queries.

## Routes

- Express, Koa, Fastify, and NestJS route extraction covers common call and
  decorator patterns, but complex wrapper functions and framework-specific
  plugins can still hide route definitions.
- Full path resolution depends on visible mount chains and constant strings.
  Highly dynamic path construction can remain unresolved.
- Middleware ordering is structural, not a full runtime execution model.
- Registrations whose method or path is computed at runtime make no `Route`:
  `app[method](url, handler)` on an app or router (module-level, or a
  parameter or local of the function), as in a helper that walks a route
  map, and `this.get(path, …)` / `.post` / … in a function assigned to a
  member of a module-level app (`app.resource = function (path, obj)`). The
  File records them in `dynamicRouteCalls` (line, expression, framework),
  and `list_routes` returns them in `dynamicRouteCalls` with a note, so an
  agent knows which lines to read. A string member (`app['get'](…)`) and
  `this` in an arrow function are not counted.
- NestJS `app.setGlobalPrefix()` is applied to the routes of the package that
  calls it when its argument is a string literal or a visible constant. Its
  `exclude` option and prefixes chosen at runtime are not modelled.
- Found by the accuracy report ([accuracy.md](accuracy.md)):
  - fastify-decorators controllers (`@Controller` with `@GET` / `@POST` / …)
    are read when the decorators are imported from `fastify-decorators`; a
    prefix given to `bootstrap(app, { prefix })` is not applied.
  - Inside a function, routes are read only when the receiver is the
    function's first parameter (a Fastify plugin `(instance, opts, done)`, a
    function passed inline to `.register(...)`, or a parameter with an app
    name) or a local created by a call (`const app = fastify(opts)`) with an
    app name. A module-level app used inside a function is not read there.
  - Inline handlers of such routes (`app.get('/', async () => …)`) get a
    synthetic Function node when the call is a statement with a path first
    (`get`, `post`, …, `use`), so the route links to them and their calls are
    theirs. This is decided by the call's shape, so a route-shaped call on a
    receiver that is not read as an app (a test server's `server.get('/', …)`)
    also gets handler functions, without a route.
  - `register(plugin, { prefix })` applies its prefix only to a plugin defined
    in the same file; a plugin imported or `require`d from another file, and
    mounts made inside a function, keep their routes unprefixed.
  - A receiver is an app or router when a variable was created by a known
    factory (`express()`, `express.Router()`, `Router()`, `new Koa()`,
    `new Router()`, `new KoaRouter()`, `fastify()`), whatever its name, or
    when it is named `app`, `router`, `fastify` or `…Router`. Apps created by
    other factories, or received from another module under another name, are
    not read.
  - Mount prefixes are followed across files when the mounted router is an
    imported name (`import users from './users'`, `const v2 =
    require('./v2')`) or `require('./x')` in place, and the other file exports
    it as its default (`export default router`, `module.exports = router`,
    `export default Router().use(…)`) or by name (`export const admin =
    Router()`). Routers re-exported through a barrel, chains assigned to
    `module.exports = Router().use(…)`, and routes declared on a chain
    (`Router().get(…)`) are not followed.

Blocks or informs: semantic sample review reports and MCP route inspection
tools.

## Calls and Dependency Injection

- Calls inside anonymous callbacks (`items.forEach(item => …)`,
  `it('…', () => …)`) belong to the enclosing function. Callbacks passed to a
  module-level call or to a module-level variable initializer get a synthetic
  `Function` node of their own instead.
- Functions stored under a property of a module-level object literal
  (`const api = { get: (id) => …, list() { … } }`, nested objects,
  `export default { … }`, `module.exports = { … }`) are `Function` nodes named
  by the property, with their calls. `api.get()` resolves to them through a
  default or namespace import of the file (by name within that file, so two
  objects with a `get` in one file share the first); named imports of the
  object (`import { TagAPI }`) and objects built inside functions, returned
  or passed to calls are not followed.
- An anonymous function assigned to a module-level CommonJS export
  (`exports.compileETag = function (val) { … }`, `module.exports.x = () =>
  …`) is a `Function` named by the property, with its calls, so
  `require('./utils').compileETag` bindings and `utils.compileETag()` calls
  resolve to it. A named function expression keeps its own name
  (`exports.x = function inner()` is `inner`), and assignments inside blocks
  or functions stay variables.
- A class field holding an arrow function or function expression
  (`setSecurityData = (data) => { … }`, `#log = function () { … }`,
  `static create = () => …`) is a method of its class as well as a `Field`:
  a `Function` node with the field's name and visibility, owning its calls,
  so `this.setSecurityData()` and `HttpClient.create()` resolve to it.
- A bare call of a name the file imports (`logout()` after `import { logout }
  from '$lib/server/session'`) resolves only through the import: a module
  cannot also declare that name, so an object property function of the file
  with it (`actions = { logout: async () => … }`) is never the target.
- Parameter decorators such as `@Param()` or `@InjectRepository()` are recorded
  as `Call` nodes of their method; class and method decorators are `Decorator`
  nodes.
- `INJECTS` comes from constructor parameter properties
  (`constructor(private readonly users: UsersService)`) and from properties
  decorated with `@Inject...()`, recorded as `Field.isInjected`, and from
  Angular `inject()` fields (`private users = inject(UsersService)`, in a
  file importing `inject` from `@angular/core`): the field takes the class
  as its type, or the type argument of `inject<Config>(CONFIG)` when the
  token is a constant. `inject()` inside functions and constructors
  (functional guards and interceptors: `const auth = inject(AuthService)`)
  is not followed. Constructor parameters without an access modifier are not
  modelled. Every typed field still resolves `this.field.method()` calls.
- Module graph: NestJS `@Module` (`imports`, `providers`, `controllers`,
  `exports`), Angular `@NgModule` (`declarations` → `MODULE_DECLARES`,
  `imports`, `providers`, `exports`) and an Angular standalone component's
  `imports` / `providers` become `MODULE_*` relationships between classes;
  elements may be names, `forwardRef(() => X)`, `X.forRoot(…)` (X) or
  provider objects (their class values). Providers given by functions
  (`provideHttpClient()`), `bootstrap`, `entryComponents` and
  `bootstrapApplication(AppComponent, { providers })` are not read.
- Found by the accuracy report ([accuracy.md](accuracy.md)), unresolved today:
  - `new X()` of a class with no constructor in its chain (calls resolve to
    functions, so there is nothing to point at);
  - calls inside module-level loops (`for (const x of xs) { register(x) }`),
    which record no `Call` node; top-level `if` / `else`, `try` / `catch` /
    `finally` and bare blocks are module-level code;
  - calls on a parameter typed as a class (`(client: HttpClient) =>
    client.x()`).
- `x.method()` resolves when x is a module-level variable initialized with
  `new C()`, in the calling file or imported from the file that declares it
  (named imports, aliases and re-exports: `import { api } from
  'src/services'`). The method is looked up on C and then its base classes.
  A parameter of the calling function with the same name hides the variable;
  default imports of an instance are not followed.
- Objects a factory builds by mixing a module in, as Express does
  (`function createApplication() { var app = …; mixin(app, proto); return
  app }` with `proto = require('./application')`): `mixin` imported from
  `merge-descriptors` or `utils-merge`, or `Object.assign(target, source)`,
  with `source` imported from a scanned file. `app.listen()` on a file-level
  variable initialized by calling the factory, and calls on the target
  inside the factory, resolve to the module-level function of that file
  with the called name (`app.listen = function listen`). Members added one
  by one at runtime (`methods.forEach(m => app[m] = …)`) are not seen.
- A bare call is left unresolved when a parameter of the calling function or a
  file-level `var` / `let` / `const` binds the same name (`var resolve =
  path.resolve`), unless that binding is an import. Variables declared inside
  a function are not in the graph, so a local binding that shadows a
  same-named function still links to it.

Blocks or informs: MCP `find_callers` and dependency impact analysis.

## Entrypoints

- Event, queue, cron, realtime, and Nest scheduler entrypoints are detected for
  common APIs, but custom wrapper libraries may appear as ordinary calls.
- Inline handlers are represented with synthetic function names; these are
  useful for graph queries but may need friendlier presentation in future UI or
  MCP responses.
- DOM listeners: every `x.addEventListener('event', handler)` is an
  `EntryPoint` (kind `dom-event`, library `dom`), on any EventTarget, so an
  `AbortSignal` listener counts too. The handler is linked when it is a
  function named in the same file, or an inline function passed to a
  module-level call; inline handlers inside functions or methods
  (`this.addEventListener('click', () => …)` in `connectedCallback`) and
  handlers imported from other files are not linked.
  `on*` attributes of HTML pages are entrypoints too; the handler is the first
  function the attribute calls, linked when the page itself defines it, and
  none when the code starts with a statement (`if (confirm(…)) remove()`).
- Vue template listeners (`@click="save"`, `@submit.prevent="send($event)"`,
  `v-on:keyup.enter="next"`) on HTML elements are entrypoints (kind
  `dom-event`, library `vue`, trigger the event without modifiers). The
  handler is the function the listener names or calls first, linked when the
  `.vue` file declares a function of that name (in `<script setup>`, an
  options object's `methods` under `export default {…}`, or a variable in
  `setup()`). Inline code (`@click="n++"`) and code that starts with a
  statement (`@keydown="if (ok) save()"`) name no handler; listeners on
  components (`<UserCard @select="…">`) are component events and no
  entrypoints; dynamic event names (`@[name]`) are not read. `methods`
  inside `defineComponent({…})` have no Function nodes, so their listeners
  stay unlinked.
- Svelte listeners on HTML elements (`onclick={save}`, `on:click={save}`,
  `on:submit|preventDefault={send}`, `onclick={() => select('all')}`) are
  entrypoints (kind `dom-event`, library `svelte`, trigger the event without
  modifiers). The handler is the function the listener names, or the one an
  arrow function calls first, linked when the `.svelte` file declares it.
  Inline code (`onclick={() => count++}`) and code that starts with a
  statement (`onkeydown={(e) => { if (…) … }}`) name no handler; `on:click`
  without a value forwards the event and is no listener; listeners on
  components are component events or props and no entrypoints.
- `customElements.define('x-tag', Class)` becomes a `Component` (framework
  `web-components`); `COMPONENT_DEFINED_BY` links the class only when it is
  declared in the same file.

Blocks or informs: MCP `list_entrypoints` and future backend runtime summaries.

## Scripts and infrastructure

- `package.json` scripts (`npm-script`), Makefile targets (`make`), shell and
  PowerShell script files (`script`, `.sh`, `.bash`, `.zsh`, `.ps1`) and
  Dockerfile `CMD` / `ENTRYPOINT` (`docker`), compose services
  (`compose-service`, in `docker-compose*.yml` and `compose*.yaml`) and GitHub
  Actions jobs (`ci-job`, in `.github/workflows/*.yml`) are `EntryPoint` nodes
  declared by their `File`. The files are read as text, not run: no variable
  expansion in commands, functions, aliases, `eval` or `source`d definitions.
  Compose and workflow YAML is read with the vendored yaml grammar (anchors,
  aliases and `<<` merges included); a file with a syntax error is skipped.
  `include:` / `extends:` in compose, GitLab CI, CircleCI and other CI systems
  are not read.
- `RUNS` (`RUNS_FILE`, `RUNS_ENTRYPOINT`; `line`, `command`) links an
  entrypoint to what a command starts, for `node`, `tsx`, `ts-node`, `bun`,
  `deno`, `python` (`-m` too), `go run|build ./pkg`, `sh` / `bash` / `pwsh
  -File`, a script path (`./scripts/deploy.sh`), `npm|pnpm|yarn run x`,
  `npm test`, `make [-C dir] target`, `run-s`, `concurrently`, and through
  `NAME=value`, `cross-env`, `npx`, `sudo`, `exec` and `time`. A Go package
  links to the files that declare `main`; a script file links to its
  `script` entrypoint. A target outside the scan (`node dist/index.js`, a
  build output) or with a variable in the path is not linked. A path inside a
  container (`/app/start.sh`) in a Dockerfile `CMD` / `ENTRYPOINT` or a compose
  `command:` / `entrypoint:` is looked up through that Dockerfile's `COPY` /
  `ADD` (from the build context, not `--from=`) and `WORKDIR`, a copied
  directory included; a binary the image builds (`/app/main`) is not a file of
  the scan. `script.sh args -- cmd` also runs `cmd`. Paths resolve
  against the directory the command runs in (the package, the Makefile, `cd
  dir && …` on the same line), then the repository root and the script's own
  directory. `npm run x` finds `x` in the package, then its parent
  directories; `prebuild` and `postbuild` are run by `build`, and Makefile
  prerequisites are run by their target. A compose service `RUNS` the
  Dockerfile its `build:` names (`context` and `dockerfile`, relative to the
  compose file) and what its `command:` / `entrypoint:` start; a workflow
  job runs the commands of its `run:` steps, in the step's or the job's
  `working-directory`, and a job with `uses: ./.github/workflows/x.yml` runs
  that workflow's file. `needs:` is not a link, and neither is `uses:` of an
  action or of a service's `image:`.
- Env reads are `USES_ENV` from the entrypoint (from the `File` for a
  Dockerfile instruction other than `CMD` / `ENTRYPOINT`): shell `$NAME` and
  `${NAME…}`, PowerShell `$env:NAME` and `GetEnvironmentVariable`, Makefile
  recipes (`$$NAME`). Only upper-case names count (`$name` is nearly always a
  local), and not shell internals or ambient variables (`PATH`, `HOME`, `PWD`,
  `USER`, `SHELL`, `TERM`, `IFS`, `RANDOM`, `BASH_*`, …), the script's own
  locals (a plain `NAME=value`, `for`, `read`, `getopts`), positional or
  special parameters, text in single quotes, comments and quoted heredoc
  bodies (unquoted ones expand and are read). Make variables `$(NAME)` are not
  env. In compose, `${VAR}`, `${VAR:-x}` and `$VAR` in any value of a service
  read the host's env (`$$` is a literal dollar; names in a key are not read).
  In a workflow, `${{ env.X }}`, `${{ secrets.X }}` and `${{ vars.X }}`
  (and `secrets.X` in an `if:`) read, and so do `$X` in a `run:` script except
  what the runner sets (`GITHUB_*`, `RUNNER_*`, `ACTIONS_*`, `CI`); the
  `run:` text is scanned with `${{ … }}` blanked out.
- Declarations are `DECLARES_ENV` from the repository with the file and line,
  like `.env` files: shell `export NAME[=…]` and `declare -x`, `NAME=value`
  before a command (also after `cross-env`, `env` and `sudo`, in a Dockerfile
  `RUN` and in Makefile recipes; not `docker run -e NAME=value` flags, and
  not assignments with no command after them such as `A=1 B=2` or
  `TIMEOUT=$((TIMEOUT - 1))`, which are the script's own), PowerShell `$env:NAME = …` and `SetEnvironmentVariable`, Makefile
  `export NAME`, Dockerfile `ENV` and `ARG`, compose `environment:` (mapping
  or `KEY=value` / `KEY` items) and the variables of an `env_file:` that is
  not a `.env*` file (those are declared by the env file reader), and a
  workflow's `env:` at the workflow, job and step level and the `env:` of a
  job's service containers and `container:`. `secrets.X` is read,
  not declared. `list_env_config { unread }`
  counts these declarations and these reads, so a variable only a script
  reads is not "unread", and a variable only a script reads and nothing
  declares is "undeclared" once any declaration exists.

## Config and Environment

- Environment and config links cover `process.env` and `import.meta.env`
  reads (`.NAME`, `["NAME"]`, and destructuring such as
  `const { PORT, DB: url = "…" } = process.env`, access `destructure`; a
  `...rest` element is not followed) and visible local config exports.
  `import.meta.env` built-ins (`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`) are
  recorded like any other name. Env vars with a client-exposed prefix
  (`NEXT_PUBLIC_`, `VITE_`, `NUXT_PUBLIC_`, `PUBLIC_`, `REACT_APP_`,
  `EXPO_PUBLIC_`, `GATSBY_`) are marked `isPublic`. Reads through an alias
  (`const env = process.env; env.PORT`), complex schema validators or config
  factories may need additional resolver logic.
- Env files the scan discovers (`.env`, `.env.*`; gitignored ones are not
  discovered) declare their variables: `DECLARES_ENV` from the Repo to the
  `EnvVar`, with the file and line, never the value. Prisma schemas'
  `env("NAME")` are reads (`USES_ENV` from the Repo, with the file).
  `list_env_config { unread: true }` compares the two: a variable a library
  reads by itself (`GOOGLE_APPLICATION_CREDENTIALS`, `NEXTAUTH_URL`) or that
  only Docker Compose or a shell script uses shows as unread, and one set by
  the CI or the shell (`CI`) as undeclared; `NODE_ENV` is never undeclared.
- Project config parsing is warning-tolerant, but warnings are diagnostic only;
  they do not yet influence confidence scores in semantic samples.

Blocks or informs: semantic confidence reporting and production-readiness
audits.

## Data Access

- Prisma, TypeORM, Mongoose, Sequelize, and Knex patterns are recognized when
  model, repository, client, or table names are visible in source.
- Data-access propagation follows resolved calls, injection fields, and
  repository/service methods, but complex factory containers or runtime DI
  registration can still hide relationships.
- `schema.prisma` files (and folders of `.prisma` files, read as one schema)
  add every model and view as a `DataModel` and a `Table` named after
  `@@map`. A Prisma call links to a declared model when its accessor
  (`prisma.user`) is the model name with a lowercase first letter, and the
  schema is the one in the calling file's nearest package (by `package.json`),
  or the repository's only schema. Otherwise the call keeps a model named after
  the accessor, with no table. Fields typed as `PrismaClient` or a class that
  extends it are treated as Prisma clients.
- Tables are read from source declarations:
  - TypeORM: `@Entity()` / `@ViewEntity()` classes, their column decorators,
    and relation decorators whose target is `() => Class` or a string.
  - Mongoose: NestJS `@Schema()` classes with `@Prop()` fields, and
    `new Schema({ ... })` objects named by `model('Name', schema)` in the same
    file, else by the variable without its `Schema` suffix.
  - Drizzle: `pgTable` / `mysqlTable` / `sqliteTable` definitions assigned to a
    variable.
  - Knex: `knex('table')` calls.
- Defaults follow each library's naming: TypeORM tables are the class name in
  snake case, Mongoose collections the model name lowercased and pluralized
  with the common English rules only (irregular plurals such as `person` →
  `people` are missed). A custom TypeORM naming strategy or a Mongoose
  `pluralize` override is not read.
- An access links to a declared model of the same library and name (the
  repository's entity, the model class, the Drizzle variable): the declaration
  in the caller's package, else the repository's only one. Sequelize models,
  entity schemas built with `new EntitySchema()`, and columns built by helper
  functions are not read. `$queryRaw` and other raw SQL are not read.
- Current false-positive guards avoid broad framework factories, but review
  findings from `semanticSamples.dataAccess` should be fed back into resolver
  rules.
- The method vocabulary covers the TypeORM Repository / EntityManager API
  (`findOneBy`, `findAndCountBy`, `softDelete`, `increment`, …), the
  Mongoose Model API (`findByIdAndUpdate`, `findOneAndDelete`,
  `countDocuments`, …), Prisma's `findUniqueOrThrow` / `findFirstOrThrow` /
  `groupBy` and Sequelize's `findAndCountAll` / `bulkCreate`.
- Sequelize models are recognized when created with `sequelize.define(…)`, a
  factory whose name says so, or as a class that extends the `Model` its file
  imports from `sequelize` / `sequelize-typescript` (or another such class).
  Class models are matched by name, so only static calls on the class name
  itself (`Order.findAll()`) count; an instance (`order.save()`) does not.

Blocks or informs: deeper ORM-specific long-term work and MCP data lineage
queries.

## MCP Tools

- `find_import_cycles` lists 30 members of each cycle and counts the rest
  (`moreMembers`). For a large cycle, pass `path` to list the members in one
  directory; without it an agent may stop at the first 30
  ([agent-benchmark.md](agent-benchmark.md#harder-questions)).

## Workspace and Package Graph

- Workspace detection supports package manager metadata and common folder
  layouts. Non-standard monorepos may need explicit include/exclude patterns
  or future configuration.
- Package ownership is path based. Generated files outside package roots may be
  attached to the workspace root package.

Blocks or informs: incremental scanning package-level invalidation and package
filtered MCP queries.

## Graph Store

- Writers are serialized by a lock file; a second `scan` on the same store
  waits for the first (or fails at once with `--no-retry-lock`). Readers never
  lock and read the last committed snapshot.
- The whole graph is held in memory by each reader and writer. That is fine
  for the sample repositories (tens of thousands of records) but not designed
  for graphs of millions of records.
- `query` accepts a read-only Cypher subset; see [cypher.md](cypher.md) for
  what is supported and where it differs from Kuzu.

Blocks or informs: future query server design.

## Parsing

- Grammars are pinned (go upgraded since the native binding): javascript
  0.23.1, typescript and tsx 0.23.2, python 0.21.0, go 0.25.0, rust 0.21.0
  (see `vendor/grammars/manifest.json`). Newer syntax that only later grammar
  releases understand produces `ERROR` nodes.
- Inline JSX event handlers create no nodes of their own, so a call inside
  `onClick={() => track()}` is attributed to the enclosing component.
- A JS/TS file with syntax errors produces a partial graph: each statement or
  class member that contains an `ERROR` or `MISSING` node is left out (the
  file is parsed again with that text blanked), and the scan reports a warning
  with the lines left out. A file that stays broken after four rounds fails
  as before. A bare `&` in a quoted JSX attribute string
  (`href="…?family=x&display=swap"`), which the tree-sitter JS / TSX grammars
  reject, is handled: a file that does not parse as written is parsed again
  with such `&` read as `_` (node text and attribute values stay as written).
  A bare `&` before a letter in JSX text (`<p>a&b</p>`) is still an error.
  A Go file with syntax errors is handled the same way (declarations,
  statements, struct fields and interface members are left out one by one).
  Python and Rust files with syntax errors are still reported as failed
  files (`--continue-on-error` keeps the rest of the scan).

- HTML pages (`.html`, `.htm`): `<script src>` becomes an `Import` of the
  page; a relative path resolves like `./path` (without `?query` / `#hash`).
  Root-relative paths (`/client.js`) and URLs are kept as written but not
  resolved, since the web root is not known. Inline scripts with a JavaScript
  `type` (none, `module`, `text/javascript`, …) are parsed as JavaScript of the
  page, with positions in the `.html` file; other script types (JSON, import
  maps, templates) are skipped. Server templates saved as `.html` (EJS,
  Handlebars) are read as plain HTML, so template tags inside a script make
  those statements syntax errors that are left out. The code of `on*`
  attributes is not parsed: only the event and the handler name are read
  (see Entrypoints).

- Single-file components (`.vue`, `.svelte`, `.astro`) are split into their
  scripts and markup. All `<script>` blocks of a file (Vue's `<script>` and
  `<script setup>`, Svelte's `context="module"` one) and Astro's `---`
  frontmatter are parsed together as the file's JS/TS, TypeScript when one
  block has `lang="ts"` (always for Astro). The template is only parsed with
  the HTML grammar: directives (`@click`, `v-if`, `on:click`), blocks
  (`{#if}`) and `{expressions}` are not read as code, so calls inside the
  template have no node (Vue, Svelte and Astro templates: see Components).
  In a Svelte file the inside of each `{…}` is masked before the HTML
  grammar reads it, so `onclick={() => go(item)}` stays one attribute; in an
  Astro file only attribute values (`title={a + b}`) are, since text
  expressions hold markup (`{posts.map((post) => <Card {...post} />)}`).
  The expressions are read from the file text by position. An Astro text
  expression with a bare `<` (`{a < b}`) can still end in a tag.

Blocks or informs: ROADMAP Phases 11–15 (components, React, Vue, Svelte,
Astro).

## Components

- React components are functions named in PascalCase that return JSX
  themselves (an arrow with a JSX body, or a `return` of their own through
  parentheses, `? :` and `&&`), PascalCase functions typed `FC` /
  `FunctionComponent`, classes that extend `Component` / `PureComponent`
  (with `React.` or not), and `memo` / `forwardRef` wrappers assigned to a
  PascalCase variable. A function that returns JSX from a nested callback
  only, a render helper in camelCase and a component created by another
  higher-order function (`styled.div`, `connect(...)(View)`, `observer`) are
  not components. A component exported through such a wrapper (`export
  default connect(mapState)(View)`, `withRouter(View)`, nested wrappers too)
  is the module's default export for `RENDERS`: a call chain where each call
  takes one argument and the last is a component of the file; the wrapper
  is recorded as `Component.defaultExportWrapper`.
- `lazy(...)` / `React.lazy(...)` assigned to a PascalCase variable is a
  Component of kind `lazy` that `RENDERS` the component it loads: the default
  export for `() => import('./Page')`, a named one for
  `() => import('./Pages').then((m) => ({ default: m.Settings }))`. A loader
  passed by name (`lazy(loadPage)`) or a computed path is not followed; the
  lazy component then renders nothing known.
- `framework` is `react` unless the file imports `preact` or `solid-js`;
  the JSX transform needs no React import, so a project on another JSX library
  without such an import is labelled `react`.
- `RENDERS` links `<Child …>` / `<Ns.Child>` elements anywhere in a
  component (including callbacks such as `items.map(...)`) to a component
  declared in the same file or imported by name or as the default export,
  through barrels. Elements that stay unresolved (library components such as
  `<Link>`, components passed as props) remain in `Component.pendingRenders`.
  Props are the attribute names; spread props (`{...rest}`) are not listed.
- Hooks: a call named `use*` (or `React.use*`, or React 19's `use`) in a
  component's function is listed in `Component.hooks`, built-in hooks
  included. `USES_HOOK` links a component's function or a custom hook
  (a function named `use*`) to the hook function the call resolves to, so
  only hooks of the repository get an edge. Hooks called in class components
  or in nested callbacks are not listed.
- Contexts: `createContext(...)` assigned to a variable is a Component of
  kind `context`. `<Ctx.Provider>` / `<Ctx.Consumer>` (and React 19's
  `<Ctx>`) are `RENDERS` of it, and `useContext(Ctx)` / `use(Ctx)` in a
  component or custom hook is `USES_CONTEXT` (Function → Component) when the
  context resolves by name or import.
- Vue: every `.vue` file is one Component (framework `vue`, line 1 to the
  end of the file), named by `defineOptions({ name })` or the `name` option,
  else by the file name in PascalCase (`user-card.vue` → `UserCard`). `kind`
  is `script-setup`, `composition` (an options object with `setup()`),
  `options` (`export default {…}` or `export default defineComponent({…})`)
  or `template` (no options object). `Component.props` lists the declared
  props: `defineProps` with a type literal, an interface or type alias of
  the same file, an object or an array (also under `withDefaults`), or the
  `props` option. Imported prop types, intersections and props declared in
  `.ts` / `.js` components (`defineComponent` outside a `.vue` file) are not
  read.
- Vue templates: tags in PascalCase (`<UserCard>`, `<Form.Input>`) or
  kebab-case (`<user-card>`, read as `UserCard`) are `RENDERS` of the
  component the file imports under that name, or under the name the
  `components` option registers it as (`components: { Item: ListItem }`).
  Props are the attributes and bindings (`title`, `:user`, `v-bind:user`,
  `v-model` as `modelValue`, `v-model:title`); event listeners (`@click`),
  slots (`#item`) and other directives are not. `<component :is>`,
  `<slot>` and other lowercase tags are elements. A tag no import resolves
  renders the component registered globally under that name in the same
  package: `app.component('UserCard', UserCard)` with a literal name and a
  component the file declares or imports, in a file that imports `vue` or on
  a receiver ending in `vueApp` (`nuxtApp.vueApp.component(…)`). A name two
  components claim, registrations in loops or through a helper, and
  `app.use(plugin)` that registers components inside a library are not
  followed. Library components (`<RouterView>`, `<router-link>`,
  `<NuxtLink>`) stay in `Component.pendingRenders`.
- `const app = createApp(App)` (or `createSSRApp`) is a Vue app, so
  `app.use(router)` is not taken for Express middleware.
- Vue component code: `<script setup>` is a Function named `<script setup>`
  (kind `script_setup`, the lines of the block) that the Component is
  `COMPONENT_DEFINED_BY_FUNCTION`; it owns the block's top-level calls,
  including calls in destructuring (`const { a } = useA()`) and anonymous
  callbacks, so they have a caller in `find_callers` and `impact_of`. In an
  options object the Component is defined by its `setup()` (a Function made
  for it inside `defineComponent({…})` too). `Component.hooks` lists the
  `use*` calls of that function, and `USES_HOOK` links the composables of
  the repository. Options API components without `setup()` have no
  function, so their `methods`, `computed` and lifecycle hooks are not tied
  to the component.
- Svelte: every `.svelte` file is one Component (framework `svelte`) named
  by its file name in PascalCase, of kind `runes` (its instance script calls
  `$props`, `$state`, `$derived`, `$effect`, …), `legacy` (an instance script
  without runes) or `template` (none). Props are the `export let`
  declarations (not `export const` or `export function`) and the names
  destructured from `$props()` (`let { a, b = 1, ...rest } = $props()`,
  without the rest); `let props = $props()` and props typed only through an
  interface give no names. Tags in PascalCase (`<TodoItem>`), dotted tags
  (`<Ui.Button>`, through `import * as Ui`) and `<svelte:component
  this={TodoItem}>` are `RENDERS` of the component the file imports;
  `<svelte:component this={view}>` with a variable stays in
  `pendingRenders`, and `<svelte:self>` and `<svelte:element>` are not
  renders. Props passed are the attributes, `{user}` shorthands and
  `bind:value` bindings (`bind:this`, `on:`, `class:`, `use:`, transitions,
  `let:`, spreads and `slot` are not); Svelte 5 `onclick={…}` on a component
  is a prop. Component events (`on:toggle` on a component,
  `createEventDispatcher`) and snippets (`{#snippet}`, `{@render}`) are not
  read.
- Astro: every `.astro` file is one Component (framework `astro`, kind
  `astro`) named by its file name in PascalCase (`index.astro` → `Index`,
  `[slug].astro` → `Slug`, `404.astro` → `404`). Props are the members of
  `interface Props` / `type Props = { … }` in the frontmatter, or else the
  names destructured from `Astro.props`. The frontmatter is a Function named
  `<frontmatter>` (kind `frontmatter`, from the opening to the closing `---`)
  that the Component is `COMPONENT_DEFINED_BY_FUNCTION`; it owns the
  frontmatter's top-level calls, and its `fetch` calls are requests like any
  other. Tags in PascalCase or dotted (`<Ui.Card>`), also inside text
  expressions, are `RENDERS` of the imported component of any framework
  (`.astro`, React, Vue, Svelte); an island keeps its hydration directive in
  `RENDERS.client` (`client:visible` → `visible`), shown by
  `component_tree` and `find_component_usages`. Props passed are the
  attributes and `{title}` shorthands; `client:`, `server:`, `set:`, `is:`,
  `transition:`, `define:` directives, spreads and `slot` are not. Astro's
  `<Fragment>`, `<Code>` and other library components stay in
  `pendingRenders`; `<script>` blocks are client code of the file, not of the
  component.
- Angular: in a file importing from `@angular/core`, each class decorated
  with `@Component({…})` is a Component (framework `angular`, kind
  `component`) named after the class, `COMPONENT_DEFINED_BY` it, with its
  `selector` and `templateUrl` as written (`Component.selector`,
  `Component.templateUrl`). Props are its inputs: `@Input()` fields and
  setters, by their alias (`@Input('heading')`, `@Input({ alias })`), and
  `input()`, `input.required()` and `model()` fields, by `alias` too.
  `@Output()` and `output()` are not read. Templates: the inline `template`
  (a string or a template literal without `${…}`) and the `templateUrl` file
  next to the component. An element whose tag has a hyphen RENDERS the one
  Angular component whose selector lists that tag (`'app-user'`, or
  `'app-user, [appUser]'`); props passed are `[input]` and `[(input)]`
  bindings and plain attributes, not events, `*structural` directives,
  `#refs`, `[attr.x]` / `[class.x]` / `[style.x]` or animations. A render
  from a `templateUrl` file keeps that file in `RENDERS.template` (its line
  is a line of that file). A tag that two components select, library elements (`<mat-icon>`) and Angular's
  `ng-template`, `ng-container` and `ng-content` stay in `pendingRenders`;
  attribute and class selectors (`[appUserList]`, `button[appBtn]`) are not
  read. When several components select a tag, the one the rendering
  component can see wins: a class its standalone `imports` list (or an
  imported NgModule exports), or one its NgModules declare or import;
  otherwise the tag stays in `pendingRenders`.
  `{{ … }}` interpolations and `@if (…)` / `@for (…)` conditions are masked
  before the HTML grammar reads the template.
- Angular listeners: `(click)="save()"` (also `(keyup.enter)`, trigger
  `keyup`) on an element without a hyphen is an EntryPoint (kind
  `dom-event`, library `angular`), declared by the file holding the template
  (the `templateUrl` file only when it was scanned) and handled by the
  component's method the code calls first; code that starts with a statement
  or a member call (`zoom.set(1)`) names no handler. Events on components
  (`(select)` on `<app-user-card>`) are outputs, not entrypoints.
  `@HostListener('click')` methods and `host: { '(click)': 'toggle()' }`
  entries are entrypoints with receiver `host`, or `window` / `document`
  for `window:resize` / `document:keydown.escape`.
- Svelte component code: the instance `<script>` (not `<script module>` or
  `context="module"`) is a Function named `<script>` (kind
  `script_instance`) that the Component is `COMPONENT_DEFINED_BY_FUNCTION`;
  it owns the block's top-level calls, including `$:` reactive statements,
  rune calls (`$state(…)`, kept as calls) and anonymous callbacks.

## Pages

- Next.js is detected per package: a `package.json` that depends on `next`.
  Projects without a manifest get no pages.
- App Router: `page`, `layout`, `template`, `loading`, `error`,
  `global-error`, `not-found` and `default` files under `app/` (or
  `src/app/` when there is no `app/`) are `Page` nodes of that kind. The path
  is the folder: route groups `(group)` and parallel-route slots `@slot`
  (kept in `Page.slot`) leave the URL, dynamic and catch-all segments keep
  Next's syntax (`[id]`, `[...slug]`, `[[...slug]]`). Private folders (`_x`)
  and intercepting routes (`(.)x`) are skipped; `basePath`, `i18n` and
  rewrites from `next.config` are not applied, so `fullPath` equals `path`.
  `.mdx` pages are not scanned.
- Pages Router: every source file under `pages/` (or `src/pages/` when there
  is no `pages/`) is a page whose path is the file path without the
  extension, `index` standing for its folder. `_app`, `_document` and
  `_error` are pages of kind `app`, `document` and `error` at `/`; `404` and
  `500` are `not-found` and `error`. `pages/api/` and test files are not
  pages; a custom `pageExtensions` in `next.config` is not read.
- Route handlers: a `route` file under `app/` gives one `Route` (framework
  `nextjs`) per exported function named `GET`, `HEAD`, `POST`, `PUT`,
  `DELETE`, `PATCH` or `OPTIONS` (declared or assigned an arrow); a
  re-export (`export { handler as GET }`) is not followed. A file under
  `pages/api/` gives one `Route` of method `ALL` handled by its default
  export, since the handler branches on `req.method` itself. A default export
  that wraps a file function (`withAuth(handler)`, or a named function passed
  inline, or an anonymous arrow, which becomes a Function such as
  `<withAuth:arg0>`) is handled by that function; one built by a library
  call (`NextAuth(options)`) or held in such a variable gives a `Route`
  without a handler.
  Paths follow the page rules above.
- Server actions: a module whose directive prologue has `"use server"` makes
  each exported function an `EntryPoint` of kind `server-action` (library
  `react`); so does a function whose own body starts with the directive. Such
  functions nested inside another function have no Function node and are not
  listed. Which form or component calls an action is not linked.
- Middleware: `middleware` (or Next 16's `proxy`) at the package root or in
  `src/` is an `EntryPoint` of kind `middleware`, handled by its exported
  `middleware` / `proxy` function or default export, or by the function a
  wrapped default export takes (`withAuth(function middleware(req) {…})`,
  same rules as `pages/api/`). The trigger lists the
  literal `config.matcher` paths (strings and `{ source }` objects); a
  computed matcher is not read, and no matcher (every request) leaves it
  null.
- `PAGE_RENDERS` links a page to the component its file exports as default.
  A default export that is not a component (a lowercase function, or one
  that only returns `null`) has no `PAGE_RENDERS`.
- React Router: in a file that imports `react-router`, `react-router-dom` or
  `react-router-native`, every `<Route>` element (router `jsx`) and every
  route object in the array passed to `createBrowserRouter`,
  `createHashRouter`, `createMemoryRouter` or `useRoutes`, inline or as a
  variable of the same file (router `object`), is a `Page` (framework
  `react-router`). `path` is the route's own segment (null for index and
  pathless routes), `fullPath` joins it onto its parent route's, and `kind` is
  `layout` with child routes, `index` for an index route, otherwise `page`.
  `Page.component` and `PAGE_RENDERS` name the component of `element={<X />}`
  (the outermost element, so a wrapper such as `<RequireAuth>` is what the
  page renders), `Component={X}` or v5's `component={X}`. Not followed: route
  arrays from another file, routes built at runtime (`.map`), `lazy` routes,
  v5 `render` props, and descendant `<Routes>` inside a routed component,
  whose paths start again from `/` instead of the parent route's.
- TanStack Router: in a file that imports `@tanstack/react-router` or
  `@tanstack/solid-router`, each `createFileRoute('/id')(…)` and the root
  route of `__root.*` is a `Page` of router `file`, and each
  `createRootRoute` / `createRootRouteWithContext` / `createRoute` elsewhere
  one of router `code` (framework `tanstack-router`). File routes take their
  path from the route id the generator wrote, not from the file name, so a
  route id that is out of date is taken as written; `fullPath` drops
  pathless (`_auth`) and group (`(marketing)`) segments and un-nests
  `posts_`. File-route kinds come from the id alone: `layout` for the root
  and pathless routes, `index` for an id ending in `/`, otherwise `page`
  (`/posts` stays a `page` even when `/posts/$postId` nests in it).
  `createLazyFileRoute` gives a separate `Page` of kind `lazy` at the same
  path, holding the code-split component. Code routes join their `path` onto
  the route `getParentRoute` returns, when that is a route variable of the
  same file (otherwise from `/`); `path: '/'` is an index route, an `id`
  without a `path` a pathless layout. `Page.component` and `PAGE_RENDERS`
  follow the `component` option when it names a component; an inline arrow
  has none. Generated files (`routeTree.gen.ts`) repeat the routes and are
  skipped; `createLazyRoute` and virtual file routes (`virtualRouteConfig`)
  are not read.
- Vue Router: in a file that imports `vue-router`, the records of the
  `routes` passed to `createRouter` (inline or an array of the same file)
  and of arrays typed `RouteRecordRaw[]` (annotation, `satisfies` or `as`)
  are `Page`s (framework `vue-router`, router `object`). `fullPath` joins a
  child's path onto its parent's; a child with path `''` is `index`, a
  record with children `layout`, one with only `redirect` `redirect`.
  `component: Home` and `components: { default: Home }` give
  `Page.component`; `component: () => import('./About.vue')` gives
  `Page.componentSource`, and `PAGE_RENDERS` goes to that module's default
  component. Records spread in (`...routes`), built by functions or held in
  untyped arrays of another file, named views other than `default`, `alias`
  paths and `defineAsyncComponent` loaders are not read.
- Angular Router: in a file that imports `@angular/router`, the routes of
  arrays typed `Routes` / `Route[]` (annotation, `satisfies` or `as`) and of
  the arrays (inline or of the same file) given to `RouterModule.forRoot`,
  `RouterModule.forChild` or `provideRouter` are `Page`s (framework
  `angular`, router `object`). `fullPath` joins a child's path onto its
  parent's; `''` under a parent is `index`, `**` is `not-found`, a route with
  `children` or `loadChildren` `layout`, one with only `redirectTo`
  `redirect`. `component: Home` gives `Page.component`; `loadComponent: () =>
  import('./login.component').then((m) => m.LoginComponent)` gives
  `Page.componentSource` and the export in `Page.component` (without
  `.then`, the default export), linked by `PAGE_RENDERS`. `loadChildren`
  (`Page.loadChildren`, `source#Export`) mounts the loaded routes under the
  loading route: an exported array of that name (or the file's default
  export), or an NgModule whose file, or a module it imports
  (`AdminRoutingModule`), passes routes to `RouterModule.forChild`
  (`Page.routerScope` `child`; `Page.routes` names each route's array). A
  route array nothing mounts is taken as a root: a child array loaded in a
  way that is not read (string `loadChildren`, arrays built by functions or
  spread in) keeps a path from `/`. Guards, resolvers, `matcher`s, named
  outlets and `title`s are not read.
- Nuxt is detected per package: a `package.json` that depends on `nuxt`. The
  source directory is the package root, or `app/` when `app/pages`,
  `app/layouts`, `app/components` or `app/app.vue` exists (Nuxt 4); a custom
  `srcDir`, `dir` or `components` option in `nuxt.config` is not read.
- Nuxt pages: each `.vue` file under `pages/` is a `Page` (framework `nuxt`,
  router `file`, no line) whose path is the file path in Vue Router syntax:
  `index` stands for its folder, `[id]` is `:id`, `[[id]]` `:id?`,
  `[...slug]` `:slug(.*)*`, `user-[id]` `user-:id`, and route groups
  `(group)` leave the URL. A page with a folder of the same name
  (`users.vue` and `users/`) is a `layout`, and that folder's `index.vue`
  its `index`. `layouts/*.vue` are `Page`s of kind `layout` without a path
  (which pages use them through `definePageMeta({ layout })` is not
  linked); `app.vue` and `error.vue` are kinds `app` and `error` at `/`.
  `PAGE_RENDERS` goes to the file's component. `definePageMeta({ path })`
  overrides, `.js` / `.tsx` pages and pages added by modules or the
  `pages:extend` hook are not read.
- Nuxt server routes: each file of `server/api/` (served at `/api/…`) and
  `server/routes/` (at `/…`) at the package root is a `Route` (framework
  `nuxt`) whose path follows the page rules (`[id]` → `:id`, `[...path]` →
  `:path(.*)*`, `index` → its folder). A method suffix (`users.post.ts`) sets
  the method, otherwise it is `ALL`. The handler is the function passed to
  the default-exported call (`defineEventHandler(async (event) => …)`,
  `eventHandler(getUser)`), or a function exported as default.
  `server/middleware/`, `server/plugins/`, Nitro `routeRules`, `apiDir` /
  `serverDir` overrides and handlers registered with `useBase` or a router
  in code are not read.
- Nuxt auto-imports: a call to a name its file neither declares nor imports
  resolves to the function exported under that name from a top-level file
  of `composables/` or `utils/` (or their `<dir>/index.*`), when one file
  exports it (in code under `server/`, from `server/utils/` instead);
  default exports, re-exports (`export { x } from`) and
  `imports.dirs` from `nuxt.config` are not read, nor are Nuxt's and Vue's
  own auto-imports (`useFetch`, `ref`), which stay unresolved. A tag no import
  resolves renders the component of `components/<path>.vue` named by its
  path in PascalCase (`components/base/Button.vue` → `BaseButton`, a file
  that already starts with the folder prefix keeps its name:
  `components/base/BaseInput.vue` → `BaseInput`; `forms/index.vue` →
  `Forms`; `.client` / `.server` dropped), also with the `Lazy` prefix
  (`<LazyUserCard>`). Components of `components/global/` with
  `pathPrefix: false`, component islands and module-provided components
  are not read.
- Astro is detected per package: a `package.json` that depends on `astro`.
  Each `.astro` file under `src/pages/` is a `Page` (framework `astro`,
  router `file`, no line; kind `page`, or `not-found` / `error` for `404` /
  `500`) with `PAGE_RENDERS` to its component, and each `GET`, `POST`,
  `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD` and `ALL` function a `.ts` /
  `.js` file there exports (`export const GET: APIRoute = …` too) is a
  `Route` (framework `astro`). The path is the file path without the
  extension (`api/posts.json.ts` → `/api/posts.json`), `index` standing for
  its folder, with `[slug]` and `[...path]` kept; files and folders starting
  with `_` are left out. `.md` / `.mdx` / `.html` pages, `getStaticPaths`
  params, `redirects` and `srcDir` / `trailingSlash` / `base` from
  `astro.config` are not read, nor are Astro actions and middleware.
- SvelteKit is detected per package: a `package.json` that depends on
  `@sveltejs/kit`. Routes come from `src/routes/` (a custom `kit.files.routes`
  is not read). A file's route path is its folder with route groups
  `(group)` left out and parameters kept in SvelteKit's syntax (`[slug]`,
  `[[lang]]`, `[...rest]`, `[id=integer]`); `REQUESTS` matches them like
  other bracket parameters (an optional `[[lang]]` counts as a required one).
- SvelteKit pages: `+page.svelte`, `+layout.svelte` and `+error.svelte` (also
  `+page@.svelte` / `+layout@group.svelte` layout resets) are `Page`s
  (framework `sveltekit`, router `file`, no line) of kind `page`, `layout`
  and `error`, with `PAGE_RENDERS` to the file's component (named `Page`,
  `Layout`, `Error`). The exported `load` of `+page.ts` / `+page.server.ts`
  (`+layout.ts` / `+layout.server.ts` for a layout) is `PAGE_LOADS` from the
  page of the same folder (`server` set for `.server` files), so
  `route_details` follows a page's loaders as well as its component, and
  `fetch` in `load` (the `fetch` of its event) is a `REQUESTS` whose consumer
  pages are the pages it loads for. Which layouts wrap which pages, and
  `load` without a page or layout file next to it, are not linked.
- SvelteKit routes: each `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`
  and `HEAD` function a `+server.ts` exports (`export function GET`, `export
  const POST: RequestHandler = …`) is a `Route` (framework `sveltekit`) of
  that method, and its `fallback` one of method `ALL`. Each form action of
  `+page.server.ts` (`export const actions = { default, login }`, also under
  `satisfies Actions`; an action written inline, as a method, or naming a
  function of the file) is a `POST` route at the page's path, `/login` for
  `default` and `/login?/name` for a named action, handled by the action's
  Function (`Function.formAction` holds the name). Hooks (`hooks.server.ts`
  `handle`), `+server.ts` handlers re-exported from another file and actions
  built elsewhere are not read.

## API Calls

- Outbound HTTP calls are recorded on their `Call` node (`httpClient`,
  `httpMethod`, `httpUrl`) for `fetch` (also `window.fetch` /
  `globalThis.fetch`, unless the file declares or imports its own `fetch`),
  the default import of `axios` (`axios(…)`, `axios.request(…)`,
  `axios.get(…)` / `.post` / …), the default import of `ky`, `ofetch` /
  `$fetch`, and Nuxt's `useFetch` / `useLazyFetch` (client `nuxt`; global, or
  imported from `#app`, `#imports` or `nuxt/app`, so a file's own `useFetch`
  hook is not one). `useAsyncData(key, () => $fetch(url))` is linked through
  the `$fetch` inside it; a `useFetch` URL given as a function or a ref is not
  read.
- Instances: `axios.create({ baseURL })`, `ky.create` / `ky.extend({ prefixUrl })`
  and `ofetch.create({ baseURL })` assigned to a top-level variable or
  default-exported mark that `Variable` (`httpClient`, `httpBaseUrl`); calls
  on it (`api.get(…)`, `api.request(…)`, `api(…)`) are followed in the same
  file and through imports (`httpReceiver` names the binding). Instances
  created inside functions, stored on objects or classes, extended from
  another instance, or given interceptors that rewrite the URL are not
  followed, nor are wrapper functions around a client.
- Data-fetching hooks: `useSWR` / `useSWRImmutable` (client `swr`) and
  TanStack Query's `useQuery`, `useSuspenseQuery`, `useInfiniteQuery` and
  `queryOptions` without a `queryFn` (client `tanstack-query`, the default
  query function fetching the key, object or v3 positional form) are a GET
  of their key when the key, or the first element of an array key, is a
  string or template starting with `/` or `http` (or a template starting
  with a substitution); `cond ? key : null` is read too. A query with its
  own `queryFn` is linked through the calls inside it; a `queryFn` or SWR
  fetcher that builds a different URL than the key (`fetch(API + key)`),
  `useSWRInfinite`, `useSWRMutation`, `useMutation` and
  `queryClient.fetchQuery` are not read.
- Angular `HttpClient` (client `angular`): `this.http.get(…)` / `.post` / …
  and `this.http.request('PUT', url)` on a field of the class typed with
  `HttpClient` from `@angular/common/http` (a constructor parameter property
  or an `inject(HttpClient)` field). `${this.baseUrl}`, or a URL that is
  `this.baseUrl`, takes the string or template the class initializes the
  field with. A client passed around or held outside the class, a base URL
  set in the constructor or read from another object
  (`${environment.apiUrl}`), and interceptors that rewrite the URL are not
  followed, so such calls stay unlinked.
- A URL (or hook key) that is a variable declared in the calling function
  (`let url = `/articles`; if (feed) url = `/articles/feed`;
  useSWR(url, fetcher)`, or reassigned in a `switch`) takes every value the
  function assigns to it: the first is `httpUrl`, the others
  `httpUrlAlternatives` (a JSON list), and the call is linked to each route
  one of them reaches. It is not read when the function declares the name
  more than once, changes it with `+=`, assigns it in a nested function, or
  assigns a value that is not a string or template URL; a `const` takes its
  declaration only.
- The method is the member name or a literal `method` option (GET without
  one); options held in a variable or spreading another object leave it
  unknown, and the call is not linked.
- `httpUrl` is resolved before matching: `${NAME}` and a bare variable
  argument become the constant they name (a string, or a template resolved
  in turn, in the same file or imported by name), the instance base URL is
  joined in front, and a `localhost` / `127.0.0.1` / `0.0.0.0` origin is
  dropped, as is an origin declared with `--api-origin <url>` (the scan
  option `apiOrigins`, for a frontend that calls its deployed backend:
  `--api-origin https://api.example.com` turns
  `https://api.example.com/users` into `/users`; the URL's path is not
  used). Env reads (`${process.env.API_URL}/posts`, `import.meta.env.*`,
  also through a constant or an instance `baseURL`) take their value from
  the `.env*` files the scan sees (nearest directory first:
  `.env.development.local`, `.env.local`, `.env.development`, `.env`,
  `.env.example`, `.env.sample`) or from a literal `??` / `||` fallback.
  Gitignored env files are not read, `.env.production` and `.env.test` are
  not used, values are not expanded (`${OTHER}`), and only URL or path
  values count. A URL resolved through env is kept only when it ends up a
  path; otherwise it stays as written and unlinked. Other origins and
  computed values (`API + "/posts"`, function calls) stay unresolved.
- `REQUESTS` links a call to the `Route` its URL reaches when the resolved
  URL (each URL, for alternatives) is a path and exactly one route is the
  most specific match (literal segments over parameters over catch-alls);
  `match` says `exact`, `parameter` or `catch-all`. Unresolved or absolute
  URLs, partly dynamic segments (`/u/${id}.json`) and ties between routes
  stay unlinked, except two routes that differ only by a trailing slash
  (gin's `/user` and `/user/`): the one whose slash matches the URL's wins.
  Query strings are ignored.
- tRPC: procedures of a top-level `router({…})`, `t.router({…})` or
  `createTRPCRouter({…})` (also default-exported) are `Route` nodes
  (framework `trpc`, method `QUERY` / `MUTATION` / `SUBSCRIPTION`,
  `fullPath` the dotted path such as `post.byId`). Mounted router variables
  (`post: postRouter`, `{ user }`) are followed in the same file and through
  imports; a router mounted by two routers gets no `fullPath`. A router
  is only read when every entry is a procedure (a chain through a
  `…procedure` ending in `.query` / `.mutation` / `.subscription`), a
  nested router call or a router variable. `mergeRouters`, routers built in
  functions, resolver functions (no `ROUTE_HANDLED_BY`) and the HTTP
  endpoint the adapter mounts (`/api/trpc`) are not read.
- tRPC calls `client.post.byId.useQuery()` / `.query()` / `.mutate()` /
  `.queryOptions()` / `.fetch()` / … link to the procedure with the same path
  and type when `client` is created by `createTRPCReact`, `createTRPCNext`,
  `createTRPCClient`, `createTRPCProxyClient`, `createTRPCOptionsProxy` or
  `createTRPCQueryUtils` (in the file or imported), bound to `useTRPC()` /
  `useTRPCClient()`, or is `client.useUtils()`. Server-side callers
  (`createCaller`, `createHydrationHelpers`), cache helpers (`invalidate`,
  `setData`) and clients passed as arguments are not read.

## Stores

- Pinia: in a file that imports `defineStore` from `pinia`, each top-level
  `const useX = defineStore('id', …)` (also exported, the old
  `defineStore({ id, … })` form, or the default export) is a `Store`
  (library `pinia`) named by its id, with the variable in `hook`. Stores
  built in functions, ids that are not string literals and store factories
  wrapping `defineStore` are not read.
- Options stores: `state` lists the keys of the object the `state` function
  returns, `getters` and `actions` the keys of those objects. Getters and
  actions written as functions become Functions that own their calls, and
  each action is a `STORE_ACTION`. `this.items.push(…)` inside an action is
  not tracked as a write; nor are state keys added later or plugin state.
- Setup stores: the setup function is `STORE_DEFINED_BY_FUNCTION`. Of the
  names it returns, a function declared in it is an action (`STORE_ACTION`),
  a `computed(…)` value a getter and anything else state; a returned value
  built another way (a composable's result) is listed as state.
- Use: a call to a hook named `use…Store` that resolves to a store (declared
  in the file or imported, through barrels) gives `READS_STORE` from the
  calling function, with the state and getters it reads in `members`
  (possibly empty), and `WRITES_STORE` when the code assigns state
  (`cart.coupon = x`, `cart.count++`, `cart.items.push(x)`), calls an action,
  `$patch` or `$reset`, or destructures an action (`const { login } =
  useUserStore()`). Uses are followed through a variable holding the store
  (anywhere in its scope, nested functions included, with the edge from the
  function that called the hook), `storeToRefs(store)` and
  `storeToRefs(useCartStore())` destructuring, and chained calls
  (`useCartStore().clear()`). An action call, also of a destructured action
  (`const { login: signIn } = useUserStore(); signIn()`), also gets
  `CALL_RESOLVES_TO` to the action's Function, so `find_callers` and
  `impact_of` reach the components that call it. Not followed: hooks with
  other names, a store passed to another function, template-only use
  (`{{ cart.count }}`), Options API helpers (`mapState`, `mapActions`,
  `mapStores`), and calls at the top level of a module (they have no
  function). A `<script setup>` block counts as one function.
- Svelte stores: each top-level `const x = writable(…)` / `readable(…)` /
  `derived(…)` with the factory imported from `svelte/store` (also in a
  component's script) is a `Store` (library `svelte`, kind the factory)
  named by the variable, which is also its `hook`; the start function or
  `derived` callback, when it has a Function, is `STORE_DEFINED_BY_FUNCTION`.
  A custom store, `const counter = createCounter()` where `createCounter` is
  a function of the same file that calls a factory and returns an object
  with `subscribe`, is kind `custom`: the factory is
  `STORE_DEFINED_BY_FUNCTION`, the other returned names (not `set` and
  `update`) are its `actions`, and an action declared as a function in the
  factory is a `STORE_ACTION` (inline arrows in the returned object have no
  Function). In a runes module (`.svelte.js` / `.svelte.ts`) a top-level
  `$state(…)` is kind `state`, with an object literal's keys as `state`;
  `$state` inside components and classes with `$state` fields are not
  stores. Stores made in functions, `export default writable(…)` and
  factories from other files are not read.
- Svelte store use: a function's uses of a store binding are recorded on its
  Function (`storeRefs`) and resolve, through imports and barrels, to the
  store declared under that name. `$count`, `get(count)`, `subscribe` and
  members read (`cart.items.length`) are `READS_STORE`; assigning or updating
  `$count`, `set`, `update`, `bind:value={$count}`, members assigned or
  mutated (`cart.items.push(x)`) and action calls (`counter.increment()`) are
  `WRITES_STORE`, with the members in `members`. A binding counts when the
  file declares the store, uses it as `$name`, imports it by name from a
  runes module (`./cart.svelte.js`, `./cart.svelte`), or, in a component, a
  runes module or a file importing from `svelte`, calls its `set` /
  `update` / `subscribe` or passes it to `get`; so `count.set(1)` in a plain
  `.ts` file that imports nothing from Svelte is not seen. The markup's uses
  (`{$count}`, `onclick={counter.reset}`, `{cart.items.length}`) belong to
  the instance `<script>` Function and are read from the expression text;
  action calls in the markup have no Call node and no `CALL_RESOLVES_TO`.
  Shadowing (a local variable or parameter with a store's name) is not
  checked, and a store passed to another function is not followed.
- Redux Toolkit: in a file that imports from `@reduxjs/toolkit`, each
  top-level `const xSlice = createSlice({ name, initialState, reducers })`
  is a `Store` (library `redux`, kind `slice`) named by its `name`, with the
  variable in `hook`; `state` lists the keys of `initialState` (an object
  literal, or a constant of the file holding one), `actions` the keys of
  `reducers` and `getters` those of `selectors`. Reducers written as
  functions (also `{ reducer, prepare }`) become Functions that own their
  calls and are `STORE_ACTION`s. `reducer` lists the names the file gives
  the slice's reducer (`default`, `cartReducer`). Each top-level
  `const store = configureStore({ reducer: { … } })` (the object inline,
  `combineReducers({ … })`, or a constant of the file holding either) is a
  `Store` (kind `store`) whose `state` lists the reducer keys and `slices`
  maps each key to its reducer as written. Slices built in functions,
  `createReducer`, `extraReducers`, the legacy `createStore` and
  hand-written reducers are not read.
- Redux use: a selector passed to `useSelector` or a `use…Selector` hook
  (`useAppSelector`) that reads its state parameter (`(state) =>
  state.cart.items`, `({ cart }) => cart.items`) gives `READS_STORE` from
  the calling function to the slice under that key, with the members read;
  the key maps to a slice through the `configureStore` reducers (a key
  given no slice, or different slices by different stores, is left out). A
  top-level `select…` function that reads its first parameter the same way
  `READS_STORE` the slice itself, and passing it by name to a selector hook
  (`useAppSelector(selectItems)`) reads what it reads, through imports. An
  action creator called inside `dispatch(…)` (`dispatch(addItem(x))`,
  declared with the slice and imported, or
  `dispatch(cartSlice.actions.addItem(x))`) gives `WRITES_STORE` to its
  slice; thunks (`createAsyncThunk`), `createSelector`, the slice's own
  `selectors`, `connect` / `mapStateToProps`, RTK Query and calls at the top
  level of a module are not followed.
- Zustand: in a file that imports `create` from `zustand` (also zustand 3's
  default import, `createWithEqualityFn` from `zustand/traditional`, or
  `createStore` from `zustand` / `zustand/vanilla`), each top-level
  `const useBearStore = create(…)` (also exported, the default export, the
  curried `create<State>()(…)`, or with the creator wrapped in middleware
  such as `devtools(persist(…))`) is a `Store` (library `zustand`, kind
  `hook`, or `vanilla` for `createStore`) named by its variable, which is
  also its `hook`. Of the keys of the object the creator returns, functions
  are `actions` (Functions that own their calls, `STORE_ACTION`) and the rest
  `state`; `combine(state, creator)` adds the keys of its first argument.
  Slices pattern stores (`create((...a) => ({ ...createBearSlice(...a) }))`),
  creators that build the object in a variable, and stores made in functions
  are not read.
- Zustand use goes through the Pinia `use…Store` rules: a hook named
  `use…Store` (declared in the file or imported, also as the default
  export) gives `READS_STORE`. A selector (`(state) => state.bears`,
  `({ bears }) => bears`, inside `useShallow`) takes the members it selects:
  state is read, an action taken is a `WRITES_STORE`.
  `useBearStore.getState().reset()` reads or calls a member (an action call
  also gets `CALL_RESOLVES_TO`), and `useBearStore.setState({ … })` writes
  the keys it sets. Hooks with other names (`useBears`), vanilla stores read
  through `useStore(store, selector)` and stores passed around are not
  followed.
- Jotai: in a file that imports `atom` from `jotai` / `jotai/vanilla` or an
  `atomWith…` helper from `jotai/utils`, each top-level `const xAtom =
  atom(…)` (also exported) is a `Store` (library `jotai`) named by its
  variable, which is also its `hook`; `kind` is `primitive`, `derived` (a
  read function), `writable` (read and write functions), `write-only`
  (`atom(null, write)`) or the helper's name, and `state` lists the keys of
  an object literal value. The read function is `STORE_DEFINED_BY_FUNCTION`
  and the write function a `STORE_ACTION`. Atoms made in functions, `atomFamily`,
  `selectAtom`, `splitAtom` and atoms in other atom libraries are not read.
- Jotai use: `useAtomValue(a)` reads, `useSetAtom(a)` writes and
  `useAtom(a)` reads (and writes when its setter is destructured), and in an
  atom's read or write function `get(a)` reads and `set(a, …)` writes; the
  atom binding resolves through imports (also a default export) to its
  Store. `members` is empty (an atom is one value). The store API
  (`store.get`, `store.set`, `useStore`), atoms passed as arguments and
  hooks used at the top level of a module are not followed.

## Go

- Modules come from every `go.mod` above a Go file (nested modules
  included), the directories a root `go.work` uses, and `replace`
  directives that point at a local directory (in `go.mod` or `go.work`).
  Imports of other modules (the standard library, dependencies) stay
  unresolved, and `vendor/` next to a `go.mod` is not scanned.
- An import names a package: it resolves (`RESOLVES_TO`) to every non-test
  file of the package's directory. Build constraints (`//go:build`, `_linux.go`)
  are not read, so every variant of a file is part of its package.
- A call resolves by package: `f()` to a function of the caller's package or
  of a `.` import, `pkg.F()` to a function of the imported package (by its
  alias, else its package clause), and `x.M()` to a method when `x`'s type is
  known: the method's receiver, a parameter, `var x T`, `x := T{}` / `&T{}` /
  `new(T)`, `v.(T)`, or `x := NewT()` / `pkg.NewT()` (the type the function returns
  first). Struct fields are followed (`h.repo.Find()`), and methods promoted
  from embedded structs are found, through anonymous struct fields too
  (`self.User.Email.IsInvalid()`). A type assertion types a local
  (`m := c.MustGet("user").(UserModel)`), and so does the result of a method
  called on a typed value or field (`u, err := h.userStore.GetByEmail(e)`:
  the method's first result, through fields; on an interface, the result
  its implementations agree on), and a range over a typed slice, array or
  map (`for _, a := range articles` with `articles []model.Article`), also
  over a call's result (`range h.items.All()`, or a local holding it). A
  package variable is typed by its declared type or its constructor
  (`var store = New()` in the package, `config.DB` in another). Locals
  whose type is not visible (results of functions outside the scan, ranges
  over other expressions) leave the call unresolved, also when they hide a
  package name. Named results and a closure's parameters
  (`execTx(ctx, func(q *Queries) error {…})`) are typed too. Locals are kept
  per function, one entry per name: a name declared again in a nested block
  or closure (`if a, ok := m[k]; ok` with `a` the receiver) keeps the outer
  declaration's type everywhere, and two locals of one name at the same
  depth in different blocks (`for _, item := range …` twice) both take the
  last one's type. A call on a call's result
  is resolved one level deep: on a package function's result
  (`api.NewHandler(s).Register(v1)`, which also mounts the routes `Register`
  declares) or a typed value's method result (`h.items.Default().Label()`).
  Longer chains (`a.B().C().D()`) and method values are not resolved yet.
- Interfaces are `Interface` nodes with their method names and embedded
  interfaces. A struct `IMPLEMENTS` every interface of the scan whose methods
  (with the embedded interfaces' methods) are all in the struct's method set:
  its methods with value or pointer receivers and those promoted from
  embedded structs. Methods match by name and by their parameter and result
  types without parameter names. A type of the scan is compared with its
  package (`domain.User` written in package `repo` and `User` written in
  package `domain` match; two packages' `User` do not), any other type by
  name, so `context.Context` and a dependency's types match whatever
  package wrote them. A generic interface's methods match by name only. An
  interface that embeds one from outside the scan (`io.Closer`) has unknown
  methods and gets no implementations, nor do interfaces without methods
  (`any`, constraints like `~int | ~float64`). Defined non-struct types
  (`type HandlerFunc func(…)`) can have methods but are `TypeAlias` nodes and
  implement nothing.
- A call on a value of interface type (`s.cache.Get()`) resolves to the
  method of every implementation, each `CALL_RESOLVES_TO` marked
  `via: "interface"`.
- `type ID = string` and `type Count int` are `TypeAlias` nodes (`aliasOf`,
  `isAlias`). Type parameters are kept as written (`typeParameters` on
  structs, interfaces, types and functions); instantiations are not tracked.
- Package-level `var` and `const` are `Variable` nodes (`kind` `var` or
  `const`, `stringValue` for plain string literals); their types and
  initializer calls are not recorded, so calls on package variables
  (`db.Query()`) stay unresolved.
- `func main` of package `main` and `func init` are `EntryPoint` nodes (kind
  `main` / `init`, library `go`). `TestX`, `BenchmarkX`, `FuzzX` and
  `ExampleX` in `_test.go` files carry `testKind` (`test`, `benchmark`,
  `fuzz`, `example`); `_test.go` files are test files.
- `pb.RegisterXServer(s, impl)` (`XServer` any service name, in a file that
  imports `google.golang.org/grpc` or calling a scanned function whose second
  parameter is `XServer`) makes one `EntryPoint` (kind `grpc`, library
  `grpc`, trigger `X/Method`) per service method, handled by the
  implementation's method, promoted ones included (an embedded
  `UnimplementedXServer`). The methods are those of the generated `XServer`
  interface when it is in the scan, else every exported method of the
  implementation's type. The implementation's type must be visible:
  `&server{}`, `new(T)`, a typed local or a constructor (`service.New()`).
  The proto package is not read, so the service is named without it.
- gRPC calls between services of the scan are linked through the code
  protoc-gen-go-grpc writes: the generated client's `c.cc.Invoke(ctx,
  "/pkg.Svc/Method", …)` (a string or a constant of the file) and
  `NewStream(ctx, desc, "/pkg.Svc/Method")` resolve (`CALL_RESOLVES_TO`,
  `via: "grpc"`) to `Method` of each struct implementing the server
  interface the same file's `grpc.ServiceDesc` names (`HandlerType`), an
  `Unimplemented…Server` stub aside. A caller of `userv1.UserClient.Save`
  so reaches `UserService.Save` of the other service through
  `userClient.Save`. Services of another repository, hand-written
  `Invoke` calls with a computed method and other RPC frameworks (Connect,
  Twirp) are not linked.
- A Go file with the `// Code generated … DO NOT EDIT.` line before its
  package clause (protoc, wire, sqlc, ent, moq…) is classified as
  generated, wherever it is.
- A cobra command (`&cobra.Command{Use: "serve", RunE: …}`, at package level
  or in a function) with `RunE` or `Run` is an `EntryPoint` (kind `cli`,
  library `cobra`) handled by that function or closure. Its trigger is the
  command path through `parent.AddCommand(child…)` calls of the same package,
  following commands a function builds and returns (`var serveCmd =
  newServeCmd()`); `Use` gives each name (its first word). Commands passed
  to `AddCommand` as calls (`root.AddCommand(newServeCmd())`) keep their own
  name.
- HTTP routes come from `net/http`, gin, echo, chi, fiber, gorilla/mux,
  go-pkgz/routegroup and kratos' `transport/http` (`Route.framework`
  `net/http`, `gin`, `echo`, `chi`, `fiber`, `gorilla/mux`, `routegroup`,
  `kratos`). A router is known when a function builds it (`gin.Default()`,
  `echo.New()`, `chi.NewRouter()`, `fiber.New()`, `mux.NewRouter()`,
  `http.NewServeMux()`, `&http.ServeMux{}`, `routegroup.New(mux)`,
  `routegroup.Mount(mux, "/api")`, kratos' `http.NewServer(…)`, or a function
  of the same file whose declared result is a router type), groups it
  (`r.Group("/api", mw…)`, chi's `Route` / `Group` callbacks and `With`,
  fiber's `Route`, `r.PathPrefix("/api").Subrouter()`, routegroup's `Group`,
  `Mount("/api")`, `With` and `Route` callbacks, kratos' `s.Route("/")` and
  `r.Group("/v1", filters…)`), or takes it as a parameter typed as one of the
  framework's router types (`*gin.RouterGroup`, `*echo.Group`, `chi.Router`,
  `fiber.Router`, `*mux.Router`, `*http.ServeMux`, `*routegroup.Bundle`,
  kratos' `*http.Server` / `*http.Router`, …).
- kratos routes are mostly in the `*_http.pb.go` files protoc-gen-go-http
  writes: `r.GET("/v1/x", _Svc_M0_HTTP_Handler(srv))`. Such a handler
  function calls one method of the service it is given (`srv.M`), and that
  method of the service's implementation is the route's handler (an
  `Unimplemented…Server` stub only when nothing else implements it). A
  route's filters (`r.GET(path, h, filters…)`) and a group's are middleware
  steps; the server's `http.Middleware(…)` option is not read. A server's
  `Handle`, `HandleFunc` and `HandlePrefix` are routes with any method.
- A route on a parameter gets the path and middleware of every call that
  passes a router in, and a named callback (`r.Route("/users", userRoutes)`)
  is such a call. A router a function returns gets the path its callers mount
  the result at (`r.Mount("/admin", adminRouter())`, `app.Mount("/sub",
  subApp())`, `mux.Handle("/v2/", http.StripPrefix("/v2", v2Routes()))`), and
  keeps its own path when nothing mounts it. Both are followed through up to
  8 functions, one `Route` per distinct mount, and mounts made in `_test.go`
  files apply only to test routes. A mount of a call whose function returns
  no router (`r.Mount("/debug", middleware.Profiler())`, `mux.Handle("/x",
  withAuth(h))`) is a route (`ALL`) of its own.
- A route on a field (`s.router.GET("/x", h)`) is taken as a root router's
  when the file imports one framework with that method. Routers stored in
  package variables or built in closures other than chi's and fiber's
  callbacks are not followed. A router a function of another file returns
  (`r := router.New()` with `func New() *echo.Echo`) is followed: the
  caller's file is parsed again with the call marked as a router constructor,
  so its routes, groups and the routers it passes on get their paths, next to
  the routes the file declares on routers of its own.
- Middleware follows each framework's order. gin, chi, fiber and echo groups
  apply `Use` to what is registered after it, and gin's `Use` returns the
  group with the middleware (`auth := r.Group("/").Use(mw)`); echo's root (`e.Use`, `e.Pre`)
  and gorilla/mux routers apply it to all their routes. routegroup's `Use`
  applies to every route of its bundle; `Route` on a root bundle configures a
  new group, so its `Use` stays inside the callback. The lifecycle steps
  are the routers' middleware, outermost first, then the route's own (echo's
  come after its handler: `e.GET(path, h, mw…)`), then the handler. A factory
  (`AuthMiddleware(true)`) is the step of the function called; fiber's
  `app.Use("/api", mw)` (a prefix first) is not followed.
- `ServeMux` patterns give the method (`GET /items/{id}`; `ALL` without one)
  and drop the host; `http.StripPrefix("/api", sub)` mounts a sub-mux's
  routes under `/api`; routegroup routes use the same patterns, and its
  `HandleRoot("GET", h)` registers the bundle's own path. For `net/http`, chi
  and gorilla/mux,
  `withAuth(http.HandlerFunc(h))` makes `withAuth` a middleware step and `h`
  the handler. gorilla/mux's `.Methods("GET", "POST")` gives one `Route` per
  method (`ALL` without it); chi serves a sub-router's `/` at its mount path.
  A closure handler is a `Function` (`<v1.POST:/items:arg1>`, kind
  `func_literal`) that owns the calls in its body; when the call before the
  method spans lines or is long, the name keeps only the method
  (`<HandleFunc:/items:arg1>`). A path or method that is
  not a string literal, a string constant of the file or `http.MethodX` is
  reported in `dynamicRouteCalls`.
- Go data access covers gorm, `database/sql` and sqlx. A call chain counts
  when it starts at a value of type `*gorm.DB`, `*sql.DB` / `Tx` / `Conn` /
  `Stmt` or `*sqlx.DB` / `Tx`: a typed parameter or variable, a struct field
  of that type, a package variable, `gorm.Open` / `sql.Open` /
  `sqlx.Connect`, or a function or local closure that returns one
  (`common.GetDB()`); a chain a local was assigned from is followed
  (`tx := db.Begin()`, `query := db.Model(&X{})`). gorm: the model is the
  struct of `Model(…)`, else the value of the method (`First(&user)`,
  `Delete(&X{})`, `FirstOrCreate`'s second argument), else a `Where` / `Not`
  / `Or` struct condition; `Table("x")` names a table. A value of type
  `interface{}` (`db.Save(data)`) or a struct declared inside a function
  gives no model, and a chain that only counts (`Count(&n)` without
  `Model`) is skipped. Operations: `Find`, `First`, `Take`, `Count`, `Scan`,
  … read; `Create` creates; `Save` and `FirstOrCreate` upsert; `Update*`
  update; `Delete` deletes. `Association("Tags")` reaches the field's
  model (`Find` / `Count` read, `Append` / `Replace` / `Delete` / `Clear`
  update) and `Preload("Author.UserModel")` reads every model on the path.
  Models are structs that embed `gorm.Model`, have `gorm:` tags, are passed
  to `AutoMigrate`, or are used in a query; a model's table is its
  `TableName()` string literal or gorm's default (snake case, last word
  pluralized: `ArticleUserModel` → `article_user_models`; a custom
  `NamingStrategy` is not read). Fields holding another model are
  `RELATES_TO` (`one` / `many`, `foreignKey`, `references`, `many2many` join
  table as `relationName`, `constraint:OnDelete`). `Raw` / `Exec` SQL and the
  SQL of `database/sql` / sqlx methods (`Query*`, `Exec*`, `Prepare*`,
  `Get`, `Select`, `Named*`, `MustExec`) are read for tables when the SQL is
  a string literal, a constant of the file, a local holding one
  (`query := \`SELECT …\``) or a `+` of those: `FROM` / `JOIN` / `USING`
  read, `INSERT [INTO]` creates (MySQL's `INSERT article SET …` too; upsert
  with `ON CONFLICT` / `ON DUPLICATE KEY`), `UPDATE` updates, `DELETE FROM`
  deletes; CTE names are not tables, and a table that is a gorm model's is
  that model. When the SQL is a string parameter of the function that runs
  it (a helper, `func (m *Repo) fetch(ctx, query string, args ...any)`),
  each call of that function passing SQL makes the access, in the caller
  (`m.fetch(ctx, query, id)` in `GetByID`); the helper itself has none. SQL
  built at runtime is not read. go-pg and other ORMs are not read.
- bun: a chain on a `*bun.DB`, `bun.Tx`, `bun.Conn` or `bun.IDB`
  (`db.NewSelect().Model(&user).Where(…).Scan(ctx)`) is an access once a
  method runs the query (`Scan`, `Exec`, `Count`, `ScanAndCount`,
  `Exists`, `Rows`); a query built and returned unrun is not. `NewSelect`
  reads, `NewInsert` creates (upserts with `On("CONFLICT …")`), `NewUpdate`
  updates, `NewDelete` deletes. The model is the struct `Model(…)` names
  (a value, a pointer, a slice, or `(*T)(nil)`); its table is the embedded
  `bun.BaseModel`'s `bun:"table:…"` tag, else bun's name (`Account` →
  `accounts`). Without a model, `Table("name")` names the table.
  `Relation("Posts")` on a select reads the field's model. `NewRaw` SQL,
  `TableExpr`, `ModelTableExpr` and bun's struct relations (`rel:` tags as
  RELATES_TO) are not read. Accesses reach the calling functions,
  routes and entrypoints as for JS.
- sqlc: in a file sqlc generated (a `// Code generated by sqlc` header), a
  value whose type is an interface with only `DBTX` methods
  (`QueryRowContext`, `ExecContext`, …, or pgx's `QueryRow`, `Exec`, …) is
  the database, so each generated `Queries` method reads the tables of its
  SQL constant (library `sqlc`, a model per table) and callers of
  `q.GetAuthor(ctx, id)` reach them through the call. The generated row
  structs are not models; `:copyfrom` queries (`CopyFrom`) are not read.
- ent: a builder started on an entity of a `*ent.Client` / `*ent.Tx` /
  `*ent.UserClient` of a package whose path ends in `/ent` (`client.User`,
  `s.client.User`, `tx.Car`) is an access: `Query`, `Get` read, `Create`,
  `CreateBulk` create (upsert with `OnConflict…`), `Update*` update,
  `Delete*` delete; `Query<Edge>(u)` and `With<Edge>()` read the edge's
  entity. A builder kept in a variable and finished later counts once, where
  it starts. Entities are the schemas (`type User struct { ent.Schema }`) of
  that name, with the table of an `entsql.Annotation{Table: …}` in the
  schema's file or ent's default (snake case, plural), and their `Edges()`
  (`edge.To` / `edge.From`, `.Unique()` for `one`) as `RELATES_TO`. The
  generated package's own code is not read for accesses.
- Go outbound HTTP is recorded on the call like the JS clients and linked
  by the same matcher (`REQUESTS`, `api_consumers`): `net/http`
  `http.Get` / `Head` / `Post` / `PostForm`, `http.NewRequest` and
  `NewRequestWithContext` (the call that builds the request, not
  `client.Do`), and `Get` / `Head` / `Post` / `PostForm` on an
  `*http.Client` (`http.DefaultClient`, `&http.Client{…}`, a typed
  parameter or variable, or a field of a struct of the same file); resty
  `R()…Get(url)` / `Post` / `Put` / `Patch` / `Delete` / `Head` /
  `Options` / `Execute(method, url)` on a `*resty.Client` (`resty.New()`,
  typed values and same-file struct fields) or a `*resty.Request`, with
  `SetBaseURL` / `SetHostURL` joined to a relative URL (a field's base when
  every value the file gives the field agrees). The method is the
  function's or a literal / `http.MethodX` / string constant. The URL is a
  string literal, a string constant or variable (the function's, the
  package's in any file, or an imported package's exported one), `+`, a
  `fmt.Sprintf` format (each verb a dynamic segment) or `path.Join`; an
  `os.Getenv("X")` part takes the nearest `.env*` file's value when it is
  a URL or path. A local origin and the `--api-origin`s are dropped as for
  JS. Anything else (a struct field like `c.baseURL`, a function result) is
  dynamic: as a segment it matches a route parameter, and at the start of
  the URL it leaves the call unlinked. Requests in `_test.go` files
  (`httptest` with `http.NewRequest`) are linked too. Other clients
  (`go-retryablehttp`, generated OpenAPI clients) are not read; gRPC is
  linked as calls (above).
- Go dependency injection (uber fx, google wire) is `INJECTS` between
  structs, as NestJS injection is between classes: a provider is a function
  passed to `fx.Provide` (directly or as `fx.Annotate(F, …)`, wherever the
  call is: `fx.New`, `fx.Module`, `fx.Options`), `wire.NewSet` or
  `wire.Build`, by name in the file's package or as `pkg.Func`; the struct
  it returns first injects the struct of each parameter (`fieldName` the
  parameter's name; the fields of an `fx.In` parameter struct, by field
  name). `wire.Struct(new(T), "*" | "Field"…)` makes T inject those fields'
  types. An interface (as a parameter, or as a provider's result) is the
  struct `wire.Bind(new(I), new(*T))` or `fx.As(new(I))` binds to it
  anywhere in the scan, else its only implementation, else nothing; for a
  provider's result, that implementation must be in the provider's package
  (a gRPC client `NewUserServiceClient(conf, …) userv1.UserClient` returns
  is not built from its parameters). Only
  structs of the scan are linked (`*sql.DB`, `*zap.Logger` are not);
  `fx.Invoke` functions, wire injector functions, `fx.Out` result structs,
  named values (`name:"…"` tags, `fx.ParamTags`) and groups are not read,
  and providers are not scoped to the `fx.New` / injector that registers
  them. Values (`fx.Supply`, `wire.Value`) take no dependencies. The calls
  in wire's generated `wire_gen.go` are ordinary calls.
- Go env reads are `USES_ENV` from the function that reads (and from its
  file; a package-level read is the file's): `os.Getenv`, `os.LookupEnv`,
  `syscall.Getenv` with a string-literal name, and each `$NAME` / `${NAME}`
  of an `os.ExpandEnv` literal. `os.Setenv` is a write and not recorded.
  viper (the package or a `viper.New()` assigned to a name): `BindEnv("key",
  "NAME")` reads `NAME`; `BindEnv("key")`, and the `Get*` / `IsSet` reads of
  a viper with `AutomaticEnv()`, read `PREFIX_KEY` upper-cased with the
  `SetEnvKeyReplacer(strings.NewReplacer(…))` pairs applied; so does each
  key of the struct `Unmarshal(&cfg)` fills (its `mapstructure:"key"` tag,
  else the field name; the struct must be declared in the same file, nested
  structs are not followed). A file with no
  viper settings of its own uses the repo's (one `SetEnvPrefix` across the
  repo; with several, no prefix). A viper on a struct field
  (`c.v.GetString`) and keys that are not string literals are not read.
  Struct tags `env:"NAME"` (caarlos0/env, cleanenv, go-envconfig; options
  after a comma dropped, `envPrefix` on a nested struct field of the same
  file prefixes its fields; go-flags' `env-namespace:"STORE"` on a group
  field prefixes them with `STORE_`, nested groups joined the same way, and
  an anonymous group struct or an embedded struct is read in place) are read by the function of the same file that
  passes the struct to `Parse`, `ParseWithOptions`, `MustParse`, `ReadEnv`,
  `ReadConfig` or `Process`, else by the struct's file; a `Prefix` option is
  not applied. `envconfig.Process("prefix", &spec)` (kelseyhightower) reads
  every exported field of a same-file struct as `PREFIX_FIELD`
  (`envconfig:"name"`, `split_words:"true"`, `ignored:"true"`, nested and
  embedded structs); a struct of another file is not followed. Route
  handlers carry the reads of their functions, as for JS. `.env` files
  declare the variables for Go projects too (`list_env_config { unread }`).
- `find_unused_exports` judges Go exports by package and counts any mention
  of the name in another package's files as a use (comments and strings
  included), so it can miss dead exports but rarely flags used ones. Uses
  from outside the scan (a library's consumers) are not seen.

## Non-code files

- Every discovered file is a `File` node with a `language` and a `sourceType`.
  Code files (JS/TS, HTML, Vue, Svelte, Astro, Python, Go, Rust) are parsed for
  declarations. The others are known formats (`css`, `scss`, `less`, `json`,
  `yaml`, `toml`, `markdown`, `shell`, `powershell`, `dockerfile`, `makefile`,
  `sql`, `proto`) or `other` (text) and `asset` (images, fonts, media,
  archives, and any file with a NUL byte in its first 8 000 bytes). They have
  no declarations yet: Phases 23–25 read them (scripts and infrastructure,
  CSS, SQL and `.proto`). The scan report counts them as `otherFiles`;
  `supportedFiles` is the number of code files.
- Vendored grammars (`vendor/grammars`, built with `npm run grammars:build`):
  `css`, `scss`, `json`, `yaml`, `bash`, `powershell`, `make` and `sql`.
  `less`, `toml` and `markdown` have none. Dockerfile and `.proto` have small
  line readers (`src/integrations/languages/plain/`) because npm has no usable
  grammar for them (`tree-sitter-dockerfile` there is a security placeholder).
  `tree-sitter-powershell` is pinned to 0.26.4 because 0.26.6 was under two
  weeks old when it was added; its grammar reports a one-line
  `param($a) $a` as an error.
- A syntax error in a JSON, YAML, shell, PowerShell, Makefile, Dockerfile or
  `.proto` file keeps the `File` node and gives one scan warning
  (`Syntax error at lines 3, 9`, at most five lines). Not checked, to avoid
  wrong warnings: CSS, SCSS and SQL (the grammars reject valid CSS range media
  queries such as `width <= 768px`, MySQL backticks and `/*! … */` comments,
  `LIMIT $2` and `FOR NO KEY UPDATE`), JSON that tools read with comments
  (`*.jsonc`, `*.json5`, `tsconfig*.json`, `jsconfig*.json`, `.eslintrc*`,
  `.babelrc`, `.vscode/`), YAML with `{{ … }}` templates (Helm, Jinja,
  Ansible), lockfiles, and files over 1 MB (`MAX_PARSED_BYTES`), which stay
  `File` nodes.
- The language of a file comes from its extension or name (`Dockerfile`,
  `Makefile`). A shebang is not read, so a script without `.sh` is `other`.
  `.svg` is an `asset` although it is text.
- `docs` is a source type for Markdown, `LICENSE`, `README`, `CHANGELOG` and
  similar files, and for any non-code file under `docs/`. Code under `docs/`
  stays `production`. Lockfiles (`package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`, …) are `generated`.
- JS/TS imports of styles, JSON and images, `new URL("./x.png", import.meta.url)`
  and HTML `<link href>` / `<script src>` resolve to the `File`. A `new URL`
  of a path without an extension (a directory alias such as
  `new URL("./src", import.meta.url)`) and a `src` or `href` with a template
  placeholder (`%PUBLIC_URL%`, `{{ x }}`, `<%= x %>`, `${x}`) are not imports.
  Root-relative paths (`/favicon.ico`), URLs, CSS `@import` / `url()` and
  Markdown links are not followed.
- `--max-files` limits code files only; the other files are always kept.
- `get_file_outline` reports a file's `language` and `sourceType`;
  `architecture_overview` and the code counts of the graph summary
  (`files.code`) leave non-code files out, while `files.total` and the
  `languages` list include them.

## Review Process

- Smoke reports include empty `falsePositiveFindings`,
  `falseNegativeFindings`, and `notes` arrays under `semanticSamples.review`.
  Manual review findings should be copied there first, then promoted into this
  backlog when they recur or affect large repositories.
- Before starting each long-term feature, run the release-readiness baseline
  and check whether any limitation above changes the feature design.
