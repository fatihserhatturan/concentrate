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
  0.23.1, typescript and tsx 0.23.2, python 0.25.0, go 0.25.0, rust 0.24.0
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
  Rust and Python files are handled the same way. No code language fails a
  file on a syntax error any more; the scan warns with the lines left out.

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
- Rust data access covers sqlx, diesel and SeaORM, as ACCESSES_DATA from the
  function that makes the call (and its routes, entrypoints and callers) to a
  DataModel; READS / WRITES follow. sqlx: the tables of the SQL literal (or
  same-file `const`) of `query!`, `query_as!`, `query_scalar!` (and
  `_unchecked`), `sqlx::query(…)`, `query_as::<_, T>(…)`, `query_scalar` and
  `QueryBuilder::new(…)`, each a DataModel named by its table; a `FromRow`
  struct is a DataModel that `query_as` maps to the table when the SQL touches
  exactly one. SQL built with `format!`, passed as a parameter, or read with
  `query_file!` is not read. Data-modifying CTEs (`with ins as (insert into
  …)`) count as the statement's own writes. diesel: `table!` tables (columns,
  `#[sql_name]`) anywhere in the repo; `#[diesel(table_name = users)]` or
  `#[table_name = "users"]` structs deriving `Queryable`, `Insertable`,
  `AsChangeset`, `Identifiable`, `Selectable` or `Associations` are models;
  `belongs_to(User)` and `joinable!` are RELATES_TO. `users::table` /
  `users::dsl::users` is a read, or the write of the `insert_into` /
  `update` / `delete` it is an argument of (`replace_into` and `.on_conflict`
  upsert); a bare `users` counts when `users::dsl::*` is imported and nothing
  shadows it. Raw `sql_query` and the `sql::<T>(…)` fragments are not read.
  SeaORM: `DeriveEntityModel` entities (the module or file name identifies
  the entity; `table_name`, columns as fields, `Relation` variants with
  `has_many` / `has_one` / `belongs_to` as RELATES_TO); `X::Entity::find()`,
  `find_by_id`, `insert`, `insert_many`, `update_many`, `delete_many`,
  `delete_by_id` (an `Entity as Alias` re-export counts), and
  `X::ActiveModel { … }.insert(db)` / `update` / `save` / `delete`, also on a
  local typed `X::ActiveModel`. An `ActiveModel` that comes from a parameter,
  a struct field or `.into_active_model()` is not followed, nor are
  `find_with_related` joins' second entity or `Statement::from_string` SQL.
- Rust outbound HTTP is recorded on the call like the JS and Go clients and
  linked by the same matcher (`REQUESTS`, `api_consumers`, with the
  `--api-origin` rules): reqwest's `reqwest::get` (and `blocking::get`), and
  `get` / `post` / `put` / `patch` / `delete` / `head` / `request(Method::X,
  url)` on a `Client` (`Client::new()`, `Client::builder()….build()`, a
  parameter, local, `static`, or a `self` / state-struct field typed
  `reqwest::Client`, `blocking::Client` or `ClientWithMiddleware`). The URL is
  a literal, a `const` / `static` or local one, `format!` (known strings
  substituted, other parts written `${expression}`), `String::from`,
  `.to_string()`, `Url::parse` and `+`; `std::env::var("X")` / `env!("X")` is
  resolved from the nearest `.env*` file when it gives a URL or path, and the
  query string is dropped. A base URL held in a struct field
  (`format!("{}/x", self.base)`), a `const` of another file, `Url::join`
  builders, `RequestBuilder`s passed between functions and other HTTP crates
  (hyper, ureq, surf, isahc) are not read; a URL that starts with an unknown
  part leaves the call unlinked.
- Rust env reads are `USES_ENV` from the function that reads (and from its
  file; an item-level read such as a `static` initializer is the file's):
  `std::env::var` / `env::var_os`, `dotenvy::var` / `dotenv::var` (and a
  bare `var` imported from `std::env`) with a string literal or a `const` name
  (a constant of another file such as `env_key::DATABASE_URL` is resolved when
  the name is declared once in the project with one value), and the compile-time `env!` / `option_env!`. `env::set_var`
  is a write and not recorded. clap derive: `#[arg(env = "X")]` /
  `#[clap(env = "X")]` and the bare `env` (the field name upper-cased) are
  read by the function of the same file that calls `Type::parse()` /
  `parse_from` / `try_parse`, else by the struct's file; a `Parser` parsed in
  another file (`Config::parse()` in `main.rs`) is the struct's file's read
  only. The builder's `Arg::new("x").env("X")` is read where it is written.
  envy: the fields of a same-file struct `envy::from_env::<T>()`,
  `envy::prefixed("APP_").from_env::<T>()` or a `let x: T = … from_env()`
  fills, upper-cased (`#[serde(rename = "x")]` honored; `rename_all` and
  `flatten` are not). The config crate (a file using `Environment`):
  `Environment::with_prefix("APP")` / `.prefix`, `.prefix_separator`, and
  `.separator("__")`; `get_string` / `get_int` / `get_bool` / `get_float` /
  `get_array` / `get_table` / `get::<T>` with a literal key, and the fields
  of the same-file struct `try_deserialize::<T>()` fills (nested structs
  followed, joined with the separator). The builder and the reads must be in
  one file, a dotted key without a `.separator(..)` is not named, and
  `default_value` / file sources are not env. Variables loaded by `dotenvy`
  come from the `.env` files, which declare them for Rust projects too.
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

## Python

- The Python grammar is tree-sitter-python 0.25.0. A file with a syntax error is
  kept: the statement with the error is left out (lines are listed in a scan
  warning), the rest stays. A broken `def` header is the weak spot: the grammar
  folds the statements after it into one error region, so everything up to the
  next statement that parses on its own is left out with it (a method after a
  broken method header can lose its class).
- Projects come from `pyproject.toml` (`[project]`, Poetry, setuptools, hatch),
  `setup.cfg` and `setup.py`, each a `Package` node (`manager` is the build
  backend: `setuptools`, `poetry`, `hatch`, `flit`, `pdm`, `maturin`, or `pip`
  for a bare `setup.py`). `pyproject.toml` wins over `setup.cfg`, which wins over
  `setup.py`. `setup.py` is never run: only literal `name=`, `version=`,
  `package_dir={"": "src"}`, `find_packages(where=…)`, `install_requires=[…]` and
  `console_scripts` lists are read, so a `setup.py` that computes them yields
  nothing. A `pyproject.toml` that only configures tools is not a project. A
  dependency matches a project of the scan by its exact name (`my-lib` does not
  match `my_lib`).
- An import resolves against source roots: the ones the metadata declares
  (`src/` layout, `package-dir`, `[tool.setuptools.packages.find] where`, Poetry
  `packages = [{ from = … }]`, hatch wheel `packages`), a conventional `src/`,
  the project directory, the scan root, and the directory pytest or a script puts
  on the path (the first parent without `__init__.py`). Namespace packages
  (directories without `__init__.py`) are importable but have no file. The real
  `sys.path` (virtualenvs, `PYTHONPATH`, `.pth` files, `sys.path.insert`) is not
  known, so an import of a name that only exists through them stays unresolved.
- `import a.b`, `import a.b as c` and `from m import x as y` become one `Import`
  per module or name, with `source` as written (`.sibling`, `..parent.mod`, `.`),
  `bindings` and `alias`; `from m import *` has `isWildcard`. `from pkg import
  name` resolves to the submodule `pkg.name` when there is one, else to `pkg`
  (its `__init__.py`); the `RESOLVES_TO` link stays on that file, but bases and
  calls follow the name on into the module `__init__.py` re-exports it from. Imports under `if TYPE_CHECKING:` have `isTypeOnly`.
  Imports in functions, `try`/`except ImportError` and `if` branches are all
  kept (no branch is evaluated). `__import__()` and `importlib.import_module()`
  are not seen.
- `__all__` of a module (`= [...]`, `+= [...]`, `.extend([...])`, `.append(…)`,
  list or tuple of string literals) is kept as the file's `allNames`; a computed
  `__all__` is ignored.
- Only project modules count as unresolved: `import os`, `import requests` and
  other names without a directory or file in a source root are standard library
  or third-party and are not counted. A relative import that finds nothing is.
- A class whose bases include `Protocol`, or `ABC` / `metaclass=ABCMeta`, is an
  `Interface` (`kind` `protocol` or `abc`) with its methods and signatures; the
  methods are `Function` nodes of the file (`methodKind` `interface-method`,
  `className` the interface), abstract ones with `isAbstract`. An ABC without
  abstract methods is still an interface. A subclass lists every base in
  `extendsNames`: a base that is a class of the scan is `EXTENDS`, one that is an
  interface `IMPLEMENTS`. Bases are found through `from m import X [as Y]`,
  `import a.b as c` / `a.b.X` and `__init__.py` re-exports (`from .x import X`,
  `import *`); a base that is not in the scan (`Exception`, `dict`, framework
  classes) is only a name. `Generic[T]`, `object` and `Protocol` itself are not bases.
- A class implements a `Protocol` structurally when it has every (non-dunder)
  method of it by name and lives in the Protocol's file or in a file that imports
  that file. Signatures are not compared, inherited methods are not counted, and a
  class in a file that only imports the Protocol through a package `__init__.py`
  is not linked.
- `@decorators` become `Decorator` nodes (`HAS_DECORATOR` on classes,
  `HAS_METHOD_DECORATOR` on functions and methods) with the dotted `name`, the full
  `expression` and the arguments as written (`args`). Decorated methods belong to
  their class (before, a decorated method was a plain function). `methodKind` is
  `staticmethod`, `classmethod`, `property` (also `cached_property`) or `method`.
  Decorators are not evaluated: `@functools.wraps` and framework decorators
  change nothing about the node.
- `parameters` are `[{name, type, default?}]` from the signature as written
  (`self` and `cls` included, `*args` / `**kw` keep their stars, `*` and `/`
  separators are left out) and `returnType` is the annotation text (a quoted
  forward reference keeps its quotes). Nothing is inferred without annotations.
- Module-level `NAME = value` and `NAME: Type = value` are `Variable` nodes
  (`const` for UPPER_CASE names), `typeName` the annotation, `stringValue` a plain
  string literal. Only single-name targets directly in the module: not tuple
  unpacking, not assignments inside `if` / `try`, not `__all__`. `isExported` is
  membership in `__all__` when there is one, else a name without a leading `_`.
- Fields (`Class.fields` `[{name, type, default?}]`, `Class.kind`) come from
  annotated assignments in the class body, for `@dataclass`, `NamedTuple`,
  `TypedDict`, attrs (`@attr.s` / `@define`, `x = attr.ib()`) and pydantic
  (`BaseModel`, `BaseSettings`, `SQLModel`, `RootModel`); `ClassVar` is skipped.
  The kind is decided from the class's own bases and decorators: a subclass of a
  user-defined model or dataclass has no `kind`, and the functional
  `namedtuple("P", ["a"])` is a variable. Enum classes get `kind` `enum` and no
  fields.

- Calls (`CALL_RESOLVES_TO`) resolve through names and types, and a call that
  they do not settle stays unresolved and is counted as such:
  `f()` (a function of the file or an imported one, through aliases and
  `__init__.py` re-exports), `Foo()` (the `__init__` of the class, own or
  inherited; none when the class has no `__init__`, e.g. a dataclass),
  `mod.f()` / `pkg.mod.f()` (through the module an import names), `Foo.method()`,
  `self.m()` / `cls.m()` (the enclosing class, then its bases depth first),
  `super().m()` (the first base that has `m`; no overrides) and `x.m()` where `x`
  is an annotated parameter, an annotated or constructor-assigned local
  (`x = Foo()`, `with Foo() as x`, `except E as x`), the result of a function with
  a return annotation (`x = make()`), or a module-level variable (annotation or
  `NAME = Foo()`). `self.a.b.m()` follows the attributes through `self.a = …` in
  the class's methods (an annotated assignment, an annotated `__init__`
  parameter, a constructor call) and the class's annotated fields.
- Types are annotation text reduced to one name: `Optional[X]`, `X | None`,
  `Union[X, None]`, `Annotated[X, …]` and quoted forward references give `X`,
  `list[X]` gives `list`. A union of two classes, `Type[X]`, `TypeVar`s, aliases
  and `Protocol` generics give nothing. Without an annotation or a constructor
  call a name has no type: `def test(service): service.place()` stays
  unresolved, and so do methods of builtins (`list.append`) and of libraries
  outside the scan. A name assigned twice with different values has no type; a
  local assigned in a branch the scan cannot evaluate keeps the first/consistent
  value only. Closures: `self` inside a nested function or lambda is not known.
- A call through a class also reaches the overrides in its subclasses and
  implementers, as extra `CALL_RESOLVES_TO` edges with `via: "override"`
  (`self.m()` in a base, `x.m()` with `x: Base`, a call of an abstract method).
  Dynamic dispatch the scan cannot see (monkeypatching, `getattr`, mixins added
  at runtime, `__getattr__`) is not followed, and metaclass or descriptor
  behavior is ignored. Decorated functions resolve as the function itself, not
  as what the decorator returns.
- The scan keeps the calls of a file's top-level code (`MODULE_CALLS`), including
  decorator expressions (`@app.route("/")`) and `app = Flask(__name__)`, but not
  calls in class bodies (`x = Field()`), default values or lambdas' own scope.
- `if __name__ == "__main__":` is an `EntryPoint` (`kind` `main`) handled by the
  first function of the file the block calls; console scripts of
  `[project.scripts]`, Poetry scripts and `setup.cfg` / `setup.py`
  `console_scripts` are `EntryPoint`s (`kind` `script`, `trigger` the command)
  declared by the metadata file and handled by `module:function` or
  `module:Class.method`. A target the module only re-exports is not followed;
  `python -m pkg` (`__main__.py`) and `entry_points` groups other than
  `console_scripts` are not entrypoints.
- Tests: `test_*.py`, `*_test.py`, `tests.py`, `conftest.py` and anything under
  `tests/` are test files (`File.isTest`). Functions get `testKind`: `test`
  (`test*` functions of test files, `test*` methods of `Test*` classes and of
  `unittest.TestCase`-style classes), `fixture` (`@pytest.fixture`, the
  `setUp` / `tearDown` hooks) and `helper` (the rest of a test file or
  `TestCase`). Test discovery configuration (`python_files`,
  `python_classes`, `testpaths`) is not read, and a test in a file that does not
  match these names is not classified.
- `find_unused_exports` covers Python: module-level functions, classes and
  variables that are not private (or are listed in `__all__`) and that no other
  file imports by name, calls, extends or implements. `from m import *` and
  `from pkg import module` / `import a.b` mark the whole module as used; console
  script handlers and `__main__.py`, `setup.py`, `manage.py`, `wsgi.py`,
  `asgi.py`, `conftest.py` are skipped. Names a framework loads by convention
  (Django settings, Django `AppConfig`s, Celery task classes) show up as
  candidates; route handlers, lifecycle steps, Celery tasks and click/typer
  commands are used (Phase 31). A library's public API used only outside the
  repository is a candidate too.
- A `Package` now also exists for Python projects, so the files of a repository
  with a root `pyproject.toml` belong to a root package, JS files included.

### Python routes and entrypoints (Phase 31)

Routes and entrypoints are written by the framework layer
(`src/integrations/frameworks/python/`), after every file is parsed: a route is a
leaf of a container (a Flask app or blueprint, a FastAPI app or router, a Django
`urlpatterns` list, a DRF router, a Starlette routes list, a Flask-RESTful `Api`),
containers are mounted into each other, and a leaf gets one `Route` per way a
request reaches it (a blueprint registered twice gives two routes), with the full
path of that way. Paths are kept in the framework's own syntax (`<int:id>` in
Flask and Django, `{id}` in FastAPI, `{id:int}` in Starlette); a `re_path` /
`url` regex is written as a path (`^articles/(?P<year>[0-9]{4})/$` is
`articles/<year>/`, a trailing `/?` is dropped).

- **Flask**: `@app.route`, `@app.get` and friends, `methods=[..]` (one route per
  method), `add_url_rule`, `MethodView` classes (a route per method the class
  defines), `Blueprint(url_prefix=..)`, `register_blueprint(url_prefix=..)`
  (which replaces the blueprint's own prefix, as Flask does), nested
  blueprints, app factories (`create_app`), and `before_request`,
  `after_request` and `teardown_request` as lifecycle steps of the routes of
  their app or blueprint. Flask-RESTful `Api(app).add_resource(Resource, "/x")`.
  `before_app_request` is a step of its own blueprint's routes only (Flask
  runs it for every request). Blueprint-level `errorhandler`s and
  `context_processor`s are no steps.
- **FastAPI**: `@app.get` and friends, `@router.api_route`, `websocket` (method
  `WS`), `add_api_route`, `APIRouter(prefix=..)`, `include_router(prefix=..,
  dependencies=..)`, `app.mount`. `Depends(..)` in a signature (as default or
  `Annotated[T, Depends(f)]`, also through an alias such as
  `SessionDep = Annotated[Session, Depends(get_db)]` imported from another
  file), `dependencies=[..]` of the route, `include_router`, router and app
  are `ROUTE_LIFECYCLE_STEP`s of role `dependency` (scope `app`, `router` or
  `route`), nested dependencies first, in the order FastAPI runs them. The
  handler's `Query`, `Path`, `Body`, `Header`, `Cookie`, `Form` and `File`
  parameters are the route's `extractors`; `@app.middleware("http")` is an
  app-level step. Class instances used as dependencies (`OAuth2PasswordBearer`)
  and `Security` scopes are not steps beyond their `__call__`.
- **Starlette**: `Route`, `WebSocketRoute`, `Mount(routes=[..])` and `Mount(app=..)`
  lists, `Starlette(routes=..)`, `Router(routes=..)`, `add_route`, `@app.route`.
  `Mount("/static", StaticFiles(..))` and other non-container mounts are no
  routes. `Route(.., middleware=[..])` and `add_middleware` are not read.
- **Django**: `urlpatterns` with `path`, `re_path` and `url`, `include("app.urls")`
  (a string module, resolved with the project's import roots), `include(module)`,
  `include([..])`, `include(router.urls)`, and `urlpatterns += [..]`,
  `.append`, `.extend`, `+ router.urls`. A function view is method `ALL`, or
  the methods of `@require_http_methods`, `@require_GET`, `@require_POST`
  and DRF's `@api_view([..])`. `View.as_view()` gets a route per HTTP method the
  class defines or inherits from a user class, plus the methods Django's and
  DRF's generic views bring (`ListAPIView` is GET, `ListCreateAPIView` GET and
  POST, `TemplateView` GET, …); the handler is the method when the project
  defines it. DRF routers (`DefaultRouter`, `SimpleRouter`,
  `trailing_slash=False`) expand `register("prefix", ViewSet)` into the standard
  actions the class has (defined, or from `ModelViewSet`, `ReadOnlyModelViewSet`
  and the `*ModelMixin`s) at `prefix/` and `prefix/<lookup>/` (`lookup_field`
  / `lookup_url_kwarg` read when the class assigns a string), and every
  `@action(detail=.., methods=[..], url_path=..)`. `MIDDLEWARE` of the
  settings file (`settings.py`, `settings/base.py`, or the first
  `settings*` file with a list) is a lifecycle step of every Django route:
  the middleware class's `__call__`, else its first `process_*` hook, or the
  middleware function; classes of installed packages are listed in `layers` but
  are no steps. `MIDDLEWARE_CLASSES` is read too.
- **Dynamic paths**: a prefix that is a string constant, or an attribute a class
  assigns (`settings.api_prefix`, `settings.API_V1_STR` with `settings =
  Settings()` or `get_settings()` annotated `-> Settings`) is resolved. Any
  other computed prefix (`prefix=f"/v{version}"`, a value read from the
  environment) leaves `fullPath` null and the expression in `pathExpression`
  (`${settings.prefix}/articles`). A route with a computed own path has a null
  `path`.
- **Not read**: the DRF router's API root view and format-suffix routes
  (`.json`), `admin.site.urls`, `format_suffix_patterns` beyond unwrapping it,
  `drf-nested-routers` / `drf-spectacular`, `django-ninja`, Flask `Api(app)`
  from `flask-restx` and `flask-smorest`, Sanic, Bottle, Tornado, Falcon, aiohttp,
  Quart blueprints beyond Flask's rules, URLs built in loops or by
  `functools.partial`, views wrapped in decorators that rebind them
  (`login_required(views.index)`), `@method_decorator`, class attribute routing
  (`Resource.as_view` with `methods` set elsewhere) and a router or app that
  is passed in as a parameter (`def init_app(app)`; a route registered on a
  parameter is not found, one on a name bound in the same function is).
  `Router` and `Api` as names of non-framework classes are only treated as
  containers when they are assigned by a call and used with the framework's
  methods.
- **Celery**: `@shared_task` and `@app.task` (also `@current_app.task`,
  `@celery.task`, with `app = Celery(..)` anywhere in the scan) functions are
  `EntryPoint`s (kind `queue`, library `celery`, trigger the `name=` argument,
  else `module.function`). `task.delay(..)`, `.apply_async`, `.s`, `.si`,
  `.signature`, `.apply`, `.retry` and `app.send_task("name")` are
  `CALL_RESOLVES_TO` (`via: "celery"`) the task. Task classes
  (`class T(Task)` with `run`), `beat_schedule` entries, and `chain` /
  `group` / `chord` structure are not read, and a task called through a variable
  (`t = send_email; t.delay()`) stays unresolved.
- **click and typer**: `@click.group()` / `@click.command()` functions,
  commands attached with `@group.command()` / `@group.group()` or
  `group.add_command(cmd, name=..)`, and `typer.Typer()` apps with
  `@app.command()`, `app.add_typer(sub, name=..)` and `typer.run(main)` are
  `EntryPoint`s (kind `cli`, library `click` / `typer`, trigger the command path
  below the root group, `db migrate`; a root click group's trigger is its own
  name). Names follow click 8 (`_` becomes `-`, a `_command` / `_group` suffix
  is dropped; an explicit name is kept as written) and typer (`_` becomes `-`).
  `@app.cli.command()` of Flask is library `flask`; Django management commands
  (`management/commands/<name>.py`, a `Command` class whose `handle` is the
  handler) are library `django`. Click options and arguments, typer's
  `@app.callback()`, and groups built by `click.Group(...)` calls or
  `cls=` arguments are not read.

### Python data access, config, outbound HTTP and DI (Phase 32)

The framework layer (`src/integrations/frameworks/python/`: `data-facts.ts`,
`data-access.ts`, `env-config.ts`, `http-clients.ts`, `di.ts`) records what a file
says at parse time and resolves it with the names of the whole scan once every
file is parsed, after the routes, so a route reaches the tables its handler (or
what the handler calls) uses. Measured on the four Python samples: precision 100%,
recall 85% for data access (81 labels) and 100% for env (26 labels),
see [accuracy](accuracy.md#python-data-access-config-and-env-phase-32).

- **Models.** SQLAlchemy (`__tablename__`, `Column`, `Mapped[...]` /
  `mapped_column`, `relationship` with `backref`, `back_populates`, `secondary`,
  `Table(...)`), Flask-SQLAlchemy (`db.Model` takes the snake-cased class name as
  its table, as the library does), SQLModel (`table=True`) and Django models
  (`Meta.db_table`, else `<app>_<model>`; the app is the directory of
  `models.py`, or `Meta.app_label`) become `Table` and `DataModel` nodes with
  columns, inherited from abstract bases and mixins. A relationship whose key is
  made by a helper (a function returning `db.Column(...)`) has no foreign key to
  read: it is `one` unless its name is plural. Django reverse relations are
  `RELATES_TO` edges named by `related_name` (else `<model>_set`); queries through
  them (`user.article_set.all()`) are not followed. A model needs its base
  chain to name `Model`, `SQLModel` or `DeclarativeBase`-style `__tablename__`: a
  model built with `type()`, `declarative_base()` aliases or metaclass tricks is
  not seen. Django proxy and abstract models have no table; multi-table
  inheritance, `through` tables and generic relations are not modelled.
- **Queries.** `session.query(M)`, `select/insert/update/delete(M)`,
  `session.get`, `session.add/add_all/merge/delete` (the model comes from a
  constructor call, an annotated parameter, `session.get` or a row a query
  returns), `M.query` and `self.query` (Flask-SQLAlchemy), Django
  `M.objects.<method>` and custom managers declared in the class, and `.save()` /
  `.delete()` of a variable typed that way or of `M(...)`. The operation follows
  the chain (`.delete()`, `.update()` after a `filter`). The receiver of
  `session.query` must be named like a session (`session`, `db`, `sess`, `s`).
  A model reached through a value the code does not type (`current_user.save()`,
  `instance.save()` of an unannotated parameter, `self.model(...)` of a manager,
  `article.comments.filter(...)`) is not found: that is where the recall of the
  samples is lost. Class-level `queryset = M.objects...` belongs to the methods
  of the class. `QuerySet` helpers, raw managers (`M.objects.raw`) are a read;
  `bulk_*`, `values().update()` and Django signals are read by their method name only.
- **Raw SQL.** A first argument of `execute`, `executemany`, `executescript`,
  `fetch`, `fetchrow`, `fetchval`, `prepare` (sqlite3, psycopg, asyncpg,
  SQLAlchemy `text(...)`, `sql.SQL(...)`) or `read_sql*` that is a literal, a
  constant of the file or class, or an f-string / `%` / `.format` template is
  read for its tables (an f-string hole becomes `?`, so `FROM {table}` names
  nothing) and must start with `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE`,
  `WITH` or `MERGE`. A statement built by `+` over a variable, read from a file
  (aiosql `.sql` query files), or written with a query builder (pypika, `psycopg.sql.Composed`)
  is not read. The table is the model's when a model has that table name, else
  a `DataModel` of library `dbapi`; the Table merges by name with the tables of
  the SQL files of Phase 25.
- **Migrations.** Alembic (`op.create_table`, `add_column`, `drop_column`,
  `drop_table`) and Django (`CreateModel`, `AddField`, `RemoveField`,
  `DeleteModel`) are merged into the table by name, with the file, line and
  change in run order, or become a table of their own (library `alembic` or
  `django`) when no model declares it. `op.execute("…")` of a revision is a
  data access of its `upgrade` / `downgrade`. Data migrations (`RunPython`),
  `alter_column`, renames and constraint operations are not read; the order is the
  file name's, not the `down_revision` chain.
- **Env.** `os.environ[...]`, `.get`, `.setdefault`, `.pop`, `"X" in os.environ`,
  `os.getenv` (and bare `environ` / `getenv` from `os`), `dotenv_values`,
  `get_key`, environs / django-environ `Env` objects and decouple's `config`
  (also under another name) are `USES_ENV` with a literal key, a constant of the
  file or a constant of another file; a computed key (`os.environ.get(name)`)
  is skipped. pydantic `BaseSettings` / pydantic-settings fields are read where
  the class is instantiated (`Settings()`, also inside `get_settings()`), named
  by the field (upper-cased) with `env_prefix` of `model_config` / `class Config`
  inherited from bases, or by `Field(env=…)`, `alias` and `validation_alias`
  (no prefix); `settings.field` reads the field of an instance (a module variable,
  a parameter annotated with the class, a local bound to a function annotated
  `-> Settings`, `self` inside the class), and `settings.X` of Django's settings
  reads the variables the settings module's `X = …` assignment reads. A settings
  class chosen at run time (`environments[env]()`), nested models with
  `env_nested_delimiter`, `env_file` contents (the `.env` file is declared by
  the env files contributor) and `SettingsConfigDict` built elsewhere are not
  followed.
- **Outbound HTTP.** `requests.get/post/put/patch/delete/head/options` and
  `request("GET", url)`, a `requests.Session()`, `httpx.get(...)`, `httpx.Client` /
  `AsyncClient` (with `base_url`), `aiohttp.ClientSession` (a name bound by
  assignment, `with … as`, an annotated parameter, or `self.client`) are recorded
  on the `Call` node and linked to the route they reach by the same rules as the
  JS/TS, Go and Rust clients (`REQUESTS`, `${env:X}` from the nearest `.env`).
  Test files are skipped, and so is a client made with `app=` or an ASGI / WSGI
  transport. A client received from another function without an annotation
  (`client = get_client()`), `urllib` / `urlopen`, `http.client`, SDKs and
  `requests_mock` are not seen; a URL made by a function is `${…}` and matches a
  route parameter or nothing.
- **DI.** dependency-injector providers (`Factory`, `Singleton`, `Callable`,
  `Resource`, … written in a `DeclarativeContainer`, also inline) make
  `INJECTS` from the class a provider builds to the classes of the providers it
  is given; `Provide[...]` markers on functions, `wiring_config`, `Configuration`
  values, `Selector`, `Dict` / `List` and overriding are not modelled. FastAPI
  `Depends` makes `INJECTS` from the class a provider function builds (it must
  be named in some `Depends(...)`, return a class by annotation and call it by name) and
  from a class whose `__init__` takes `Depends(...)`, to the class each dependency
  provides; the chain of a route's own dependencies stays its lifecycle steps
  (Phase 31). `INJECTS` is between classes, so a handler or a provider that
  returns a dict, a pydantic response model or nothing has none.

### Python measurement (Phase 33)

Measured on pinned samples ([accuracy](accuracy.md#python-samples-phase-33)):
call resolution has 100% precision on the Flask (63 labeled sites, recall 58.7%) and
FastAPI (80 sites, recall 98.8%) Conduit backends, and the Django, Flask and FastAPI
full-stack samples link 32, 33 and 33 of 32, 33 and 33 labeled frontend requests. What
the call recall leaves out:

- **A base class chosen at run time.** `Model = db.Model` with
  `db = SQLAlchemy(model_class=CRUDMixin)` hands every model the methods of
  `CRUDMixin`, but only through an argument; `article.save()` has no target. The
  same holds for any base passed to a factory.
- **Receivers from a query chain or a proxy.** `Article.query.filter_by(..).first()`
  and `current_user.profile` have no static type, so the methods called on them
  (`.favourite(..)`, `.follow(..)`, `.set_password(..)`) are not linked. An
  `await`ed call is typed by the return annotation of the function it calls only
  when the result is assigned directly; `user = await repo.get_user_by_email(..)`
  inside `try` is still a gap (one FastAPI site).
- **Class-body calls.** `reference_col(..)` in a column definition at class level
  is not linked.
- **Classes without `__init__`.** A call of a pydantic model or a marshmallow schema
  that has no `__init__` of its own has no target (it runs library code).
- **Frontend requests.** A Flask or Django route written with converters
  (`<int:id>`, `<slug>`) is reached by a `${…}` URL segment; `<path:rest>` takes the
  rest of the path. Django's regex routes (`url(r'^articles/(?P<slug>[-\w]+)/?$')`)
  are read as the path the scan composes, and a request to a route the backend does
  not have (`DELETE /api/articles/:slug` on the Django sample) stays unlinked, as it
  should.
- **Memory.** A project with a shell script loads the shell grammar, which costs
  about 650 MB peak: the FastAPI Conduit samples peak at 667 and 800 MB cold
  because of one `postman/run-api-tests.sh` (the template has eight `.sh` files); without that file the scan peaks at
  144 MB (`/usr/bin/time -l`). The warm scan, which reads the parse cache, is 135–148 MB.

## Rust

- The Rust grammar is tree-sitter-rust 0.24.0. A file with a syntax error is
  kept: the item, statement or member with the error is left out (lines are
  listed in a scan warning), the rest of the file stays in the graph.
- Crates come from every `Cargo.toml` with a `[package]` in the scan. Crate roots
  are `src/lib.rs`, `src/main.rs`, `[lib] path`, `[[bin]] path`, `src/bin/*.rs`
  and the direct children of `tests/`, `examples/` and `benches/`. `[workspace]
  members` globs are not read: every package found is a member.
- A `use` path resolves through the `mod` tree of its crate: `mod.rs`,
  `foo.rs` + `foo/`, `#[path = "…"]` and inline `mod x { … }` (an inline module
  is not a file: a path into it resolves to the file that holds it). It follows
  `pub use` re-exports (items, aliases and globs) up to eight steps. `use` groups
  are split into one `Import` per path; `as` aliases are kept in `alias`, globs in
  `isWildcard`, `pub use` in `isReExport`.
- An import resolves to the file of the deepest module the path names; the item
  after it (`Type`, `func`) is not a node link yet. A `use` of an enum variant or
  an associated item stops at the enum's file.
- Another crate is found by its dependency key (`-` → `_`, `package =` renames,
  `workspace = true`, `path = …`) or by its package name. Only packages inside
  the scan resolve; `std`, `core`, `alloc` and crates.io dependencies are never
  counted as unresolved.
- `#[cfg(...)]` is not evaluated: a `mod x;` behind a feature that is off still
  resolves, and two `#[cfg]`-alternative files for one module resolve to the
  first. A file claimed by two crates (shared with `#[path]`) belongs to the first.
- `Cargo.toml` is read with a small tolerant reader (tables, dotted keys, inline
  tables, multi-line arrays); `[patch]`, `[replace]` and `.cargo/config.toml`
  path overrides are ignored. Macros that generate `mod` or `use` items are not
  expanded.
- A trait is an `Interface` (`methods`, `methodSignatures`, supertraits in
  `embeds`, `typeParameters`). `impl Trait for Type` becomes `IMPLEMENTS` from the
  type's `Class` to the trait, when both are nodes of the scan and reachable by name
  in the impl's file or through its `use`s; a std trait (`Display`) has no node.
  An enum is an `Enum`, which has no `IMPLEMENTS` edge (the schema relates classes to
  interfaces): its `impl` methods are file-level functions with `className` set.
  Trait default methods have `methodKind: "trait-default"`, trait impl methods
  `methodKind: "trait-impl"` and `implementsTrait`.
- Structs (`Class`) record `fields` (tuple fields are named `0`, `1`…) and
  `typeParameters`; enums record `variants`; unions, associated types and
  associated consts inside impls/traits are not nodes. `const` and `static` are
  `Variable` nodes (kind `const` / `static`) at file or module level only.
- Attributes are `Decorator` nodes (`name` such as `derive` or `tokio::main`, `args`
  as the top-level comma-split list) on structs, functions and methods
  (`HAS_DECORATOR`, `HAS_METHOD_DECORATOR`), enums (`ENUM_HAS_DECORATOR`) and traits
  (`INTERFACE_HAS_DECORATOR`). Attributes on type aliases, consts, fields, variants,
  impl blocks and `mod` items are not recorded (`#[cfg(test)]` on a `mod` is read for
  test classification). Inner attributes (`#![…]`) are ignored. Derive-generated
  items are not expanded.
- `macro_rules!` is a `Function` (kind `macro_rules`, exported with `#[macro_export]`)
  that `name!(…)` calls resolve to by name; macros are not expanded, so calls
  inside a macro's token tree are not seen.
- `fn main` of `main.rs`, `build.rs`, `src/bin/**` and `examples/**`, and any
  top-level function with a `#[…::main]` attribute (`tokio`, `actix-web`,
  `async-std`…), is an `EntryPoint` (kind `main`, or `build-script`; `library` is
  `rust` or the runtime). Binaries declared with `[[bin]] path` elsewhere are not.
- Functions with `#[test]`, `#[…::test]` (`tokio::test`…), `#[rstest]` or
  `#[test_case]` have `testKind: "test"`, `#[bench]` has `"bench"`, and other
  functions inside an inline `#[cfg(test)]` module `"helper"`. Files under `tests/`
  and `tests.rs`, `*_test.rs`, `*_tests.rs` are test files; a file only mounted by
  `#[cfg(test)] mod x;` under another name is not detected as a test file.
- `parameters` is `[{name, type}]` (`self` has the type `Self` with its reference
  prefix, `&mut Self`); `returnType` is the text after `->`.
- Calls resolve by name, from the file's own items and what its `use` / `mod`
  declarations bind (an import binds a module, or an item of the file it resolves
  to), with each file's crate and module path (`File.rustCrate`, `rustCrateName`,
  `rustModule`): `f()`, `module::f()`, `crate::` / `self::` / `super::` paths,
  `Type::new()` / `Type::method()` / `Self::method()`, `Trait::method(x)`,
  `<T as Trait>::method()`, `name!()` macros, and another crate by its `use` name
  (`my_core::util::f()` also without a `use`). Turbofish (`Vec::<u8>::new`) is dropped.
  A crate renamed with `package =` is found only through a `use` of the rename.
- A method call `x.m()` takes `x`'s type from `self` (the impl type; a trait for a
  default method), a typed parameter or `let x: T`, a struct literal, or a
  constructor call (`let x = T::new()`, `?`, `.await`, `.unwrap()` and `.expect()`
  after it: the function's return type, `Self` and `Result<T, _>` unwrapped);
  then `self.field.m()` follows the struct's `fields`. References, `Box`/`Arc`/`Rc`/
  `RefCell`/`Mutex`/`RwLock` and generics are looked through; a type alias is
  followed. A type found by name in the file or its imports, else the only type of
  that name in the crate. Not typed: closure parameters, `if let` / `match` /
  `for` bindings, results of method chains, fields of non-struct values, statics.
- A method on a trait object (`&dyn T`, `Box<dyn T>`), an `impl T` argument or a
  bounded type parameter (`N: Notifier`, also in a `where` clause) resolves to the
  trait's default method and every `impl T for X` method, marked `via: "trait"`;
  `Trait::method(x)` the same. A supertrait's methods are searched when the trait
  has none. Implementations are matched by trait name across the scan. The method
  of an extension trait of the repository implemented for a type outside it
  (`impl<T, E> ResultExt<T> for Result<T, E>`) is the target of any method call
  of that name whose receiver is untyped, also on a chain.
- Calls inside a macro's token tree (`println!("{}", f())`, `sqlx::query!(…, x.m())`,
  `assert_eq!(f(), 1)`, `vec![f()]`) are not seen; a macro is not expanded. A call
  through a function pointer, closure or generic trait bound without a repository
  trait is not resolved. A method call's line is the line of its method name.
- `find_unused_exports` covers Rust by crate: a `pub` item (not `pub(crate)` /
  `pub(super)` / `pub(in …)`) counts as used when another crate of the scan calls it
  or names it (calls and re-exports through the graph; types, constants, enums
  and traits by a whole-word mention in another crate's `.rs` files). Items of binary
  crates (`main.rs`, `build.rs`, `src/bin`, `examples`, `tests`, `benches`) and test
  code are skipped, and items a library offers to consumers outside the scan are
  not seen. `deadFunctions` skips `#[test]` functions and `cfg(test)` helpers.
- HTTP routes (`src/integrations/frameworks/rust/`, schema 81): axum
  (`Router::new().route(path, get(h).post(h2))`, `nest`, `merge`, `route_service`,
  `layer` / `route_layer`), actix-web (`#[get("/x")]` and `#[route(…)]`,
  `App::new().service(…)`, `web::scope`, `web::resource`, `.route(…)`, `.configure(f)`),
  Rocket (`#[get("/x")]` attributes with the query part dropped, `routes![…]`,
  `.mount(base, …)`) and warp (`warp::path!`, `warp::path(…)`, `and` / `or`, method
  filters, `and_then` / `map`). Paths are joined through nested routers across
  functions, modules and crates (a function returning a router, a scope, a
  `ServiceConfig` function or a `routes![…]` list is mounted where it is called; one
  Route per distinct mount). Layers / `wrap` / `from_fn` middleware that resolve to a
  function are `ROUTE_LIFECYCLE_STEP`s, outermost first; every layer is also in
  `Route.layers`, and the handler's `Path` / `Query` / `Json` / `State` / `Form` / `Data`
  parameters are in `Route.extractors`. Limits: a layer applies to what the chain
  registered before it (axum's rule; actix `wrap` and warp `with` are read the same
  way); a registration whose path is not a literal or a constant of the file, a
  route registered in a loop and a computed mount are reported in
  `File.dynamicRouteCalls`, not as Routes; warp routes get `:param` / `:u32`
  segments and a closure handler has no function; a router built through a field,
  a trait or a macro is not followed; routes in `tests/` and test functions are
  ignored; a bare `#[get]` attribute is read only when the file imports actix-web
  or Rocket (not both).
- Other entrypoints: tonic `XServer::new(value)` / `with_interceptor` / `from_arc`
  makes an EntryPoint (kind `grpc`, trigger `X/method`) per method of every
  `impl X for Type` in the scan, narrowed to the value's type when it is a struct
  literal, a `Type::new()` / `default()` constructor (also in an `Arc` or `Box`) or
  a typed local or parameter; the trigger has no proto package, and a trait that
  tonic generates but the scan does not contain (no implementation in the scan) gives
  none. clap: `#[derive(Parser)]` with `#[derive(Subcommand)]` enums, also nested through
  `#[derive(Args)]` structs or `#[command(subcommand)]` fields, and the builder's
  `Command::new("app").subcommand(Command::new("serve"))` give EntryPoints (kind
  `cli`, trigger the command path such as `db seed`; kebab-case names or
  `#[command(name = …)]`; a parser with no subcommand is the crate's own name).
  A command's handler is the first function its `match` arm calls
  (`Commands::Serve { .. } => serve(..)`, `Some(("serve", m)) => serve(m)`); builder
  arms are matched by the command's own name, not its path, and a command that has
  subcommands is not an EntryPoint itself.
- Measured on three pinned Rust samples ([accuracy.md](accuracy.md)):
  `internet-rust-axum-realworld` (axum + sqlx, one library crate and a bin: 19
  hand-labeled routes, precision 100%, recall 100%; 47 call sites with a
  repository target, precision 100%, recall 70.2%; 49 data accesses and 2 env
  reads, both 100%), `internet-rust-actix-diesel-realworld` (actix-web 4 +
  diesel 2: 20 routes, 48 data accesses and 3 env reads, all 100%) and
  `internet-realworld-rust-fullstack` (the Next.js Conduit frontend with the axum
  backend: 33 frontend requests linked to routes, 100%). Rocket, warp, tonic,
  clap, SeaORM, envy and the config crate are covered by fixtures only. Hand-
  labeling the actix-diesel sample found three gaps, now fixed: verbs imported
  bare (`use actix_web::web::{get, post}`; `get().to(h)`) registered no routes,
  `let t = table.filter(..); diesel::delete(t)` was read as a read, and
  queries built by a helper and run as `t.load::<Model>(conn)` were not
  seen. Calls are not labeled for the actix-diesel sample: its handlers reach
  the use cases through `state.di_container.<usecase>` fields of
  `Arc<dyn Trait>`, whose method calls the scan does not type. Not measured on a
  multi-crate workspace sample: cross-crate paths are covered by the
  `rust-workspace` and `rust-calls` fixtures only.

## C and C++

- The grammars are tree-sitter-c 0.24.1 and tree-sitter-cpp 0.23.4, vendored as
  `vendor/grammars/c.wasm` (625,963 bytes) and `cpp.wasm` (3,435,982 bytes). The
  extensions are `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx`, `.ipp` and
  `.inl`; a `.h` file is C unless the scan has a C++ source (any of the other
  extensions but `.c`), then every `.h` is read as C++. The preprocessor is not run.
- A file with a syntax error is kept: the declaration or statement with the error
  is left out (lines are listed in a scan warning). Unknown macros are the usual
  cause: a statement macro (`cJSON_ArrayForEach(a, b) { … }`, `FOO_BEGIN`), a macro
  that wraps a whole declaration, and `#if` / `#else` branches that open or close a
  brace on only one side. Three patterns are read as blanks of the same length so
  they do not cost the declaration: an export or calling-convention macro whose name
  ends in `_API`, `_LIB`, `_EXPORT`, `_CDECL`, `_STDCALL`, `_CALL`, `_DECL`,
  `_CONSTANT`, `_VISIBLE`, `_PUBLIC`, `_INLINE` (`class TINYXML2_LIB XMLNode`,
  `static void * CJSON_CDECL f()`); `#ifdef __cplusplus` / `extern "C" {` / `#endif`
  guards; and Catch2's string-named tests (`TEST_CASE("name", "[tag]") { … }`,
  `SECTION("…") { … }`). A macro of another name before a declaration
  (`MY_EXPORT int f();` is fine, `DECLARE_THING int f();` is not) still drops it.
  `CJSON_PUBLIC(type) name(…)` style wrappers keep the declaration; the return type is
  read from inside the wrapper.
- `#include "…"` resolves relative to the including file, then through the `-I`,
  `-iquote`, `-isystem` and `-idirafter` directories of `compile_commands.json` (read
  from the scan root, `build/`, `out/`, `cmake-build-debug/` or `cmake-build-release/`;
  a file's own command first, the union of all commands for headers), and finally to
  the only scanned file whose path ends with the written path (a project without
  compile commands). `#include <…>` resolves only through the include directories;
  one that does not is external and not counted. A quoted include nothing resolves
  is counted in `unresolvedRelativeImports`. CMake's `include_directories` and
  `target_include_directories` are not read yet (Phase 35); neither are `-include`
  flags, `#include_next`, macro-named includes (`#include MACRO`) or `.def` files.
- Names are visible through includes: a call sees the declarations of its own file and
  of every file it includes, transitively. A name that is only reachable because the
  include did not resolve, or that comes from a library outside the scan, leaves the
  call unresolved. Nothing is guessed from a bare name. A `.c` file that includes
  another `.c` (cJSON's tests include `../cJSON.c`) sees its static functions, as the
  compiler does.
- Declarations are `Function`, `Class` (struct, union and class, with `bases`,
  `virtual`, `override`, `isAbstract` for a pure virtual member, and fields with their
  types), `Enum`, `TypeAlias` (`typedef` and `using`), `Variable` (file-level
  variables, and object-like `#define` macros with kind `macro`) and, for a
  function-like `#define`, a `Function` of kind `macro`. Namespaces are not nodes: each
  declaration carries `namespace` and `qualifiedName` (`geo::Circle::area`), and the
  file lists `namespaces`, `using namespace`, `using ns::name` and namespace aliases
  in `cppScope`. `typedef struct { … } Name;` is a struct named `Name`; `typedef struct
  Tag { … } Name;` is the struct `Tag` and an alias `Name`. Template parameters are
  kept as written in `typeParameters`; templates are not instantiated.
- A prototype in a header is a `Function` with `isDeclaration`, linked by `DEFINED_BY`
  to its definition: the definition of the same qualified name and parameter count (and
  parameter types when several match) in a file that includes the header, or else the
  only non-static definition of the name in the scan. A call resolves to the
  definition (`via: header`); to the prototype only when no definition is scanned
  (`via: declaration`). Prototypes and macros are not declarations for
  `find_unused_exports`.
- Calls: free functions (`f()`, `ns::f()`, `::f()`, `using namespace`, `using ns::f`,
  namespace aliases, names from enclosing namespaces), members of the enclosing class
  and its bases, and methods on typed receivers: `T x`, `T* p`, `T& r`, `const T&`
  parameters, `auto x = T(…)`, `new T`, `std::make_unique<T>` / `make_shared<T>`,
  smart pointers (`unique_ptr<T>` is a `T`), `this`, fields (also inherited and
  chained, `a.b.c()`), global variables, `auto x = f()` through `f`'s return type, and
  `typedef` / `using` aliases. Overloads are chosen by argument count (defaults and
  `...` allowed); several candidates of one count are all linked (`via: overload`).
  A virtual call (`virtual` or `override` member, on a base-class receiver) links the
  base (`via: virtual`) and every override in the classes below it (`via: override`);
  an explicit `Base::f()` call is not virtual. A macro call resolves to the macro
  (`via: macro`) because the preprocessor runs first. Constructor calls (`T x(…)`,
  `new T(…)`, `T(…)`) and destructors, operators, function pointers and calls through
  `std::function` are not linked; templates are not instantiated, so a call on a type
  that is a template parameter or `decltype` is unresolved, and so is ADL (a call
  found only through the namespace of its argument).
- `main` is an `EntryPoint`. GoogleTest `TEST`, `TEST_F`, `TEST_P`, `TYPED_TEST` and
  `TYPED_TEST_P` (named `Suite.Name`) and Catch2 `TEST_CASE`, `SCENARIO`,
  `TEST_CASE_METHOD` and the template variants (named by their string) are `Function`
  nodes of kind `test` with `testKind` `gtest` or `catch2`; a file with one is a test
  file, and so are `*_test.cc`, `*_unittest.cpp`, `test_*.c` and `*Test.cpp`. Catch2's
  `SECTION`, `GIVEN`, `WHEN` and `THEN` are read as blocks of their test; they are not
  nodes. Unity's `TEST_ASSERT*` and `RUN_TEST` are macros and resolve like any macro.
- `find_unused_exports` judges non-static functions, classes, structs and enums
  (anything outside an anonymous namespace). `foo.h` and `foo.cpp` count as one unit:
  a name is used when a call from another unit reaches its definition, or another unit
  mentions it (a function: in a source file, so a prototype in some other header is no
  use). `static` and anonymous-namespace functions are checked as `deadFunctions`.
  Uses through function pointers or macros, and by code outside the scan, are not
  seen.
- Measured on the pinned samples (`docs/accuracy.md`): cJSON, 110 of 110 labeled
  call targets, no false positive; tinyxml2, 9 of 9 on the labeled program, and 642 of
  the 691 call sites of `tinyxml2.cpp` resolve. Cost: loading the C++ grammar adds
  about 11 MB of RSS; parsing a header whose macros the grammar cannot read grows the
  WebAssembly heap (tinyxml2.h before the export macro was read as blank: +285 MB RSS
  once, reused afterwards), and each parse worker has its own heap. cJSON (161
  files, 55 code files) scans in 0.25 s and tinyxml2 (272 files) in 1.2 s.
- Not read yet: CMake and Make (Phase 35), HTTP and RPC frameworks, env and data access
  (Phase 36).

## Non-code files

- Every discovered file is a `File` node with a `language` and a `sourceType`.
  Code files (JS/TS, HTML, Vue, Svelte, Astro, Python, Go, Rust) are parsed for
  declarations. The others are known formats (`css`, `scss`, `less`, `json`,
  `yaml`, `toml`, `markdown`, `shell`, `powershell`, `dockerfile`, `makefile`,
  `sql`, `proto`) or `other` (text) and `asset` (images, fonts, media,
  archives, and any file with a NUL byte in its first 8 000 bytes). They have
  no declarations unless a later bullet says so (scripts and infrastructure,
  CSS, SQL and `.proto` files are read). The scan report counts them as `otherFiles`;
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
- CSS, SCSS and Less files (`.css`, `.scss`, `.sass`, `.less`) are read by a
  scanner of their own (`languages/plain/styles.ts`), not by the vendored css
  and scss grammars: those reject valid code (`@use "x" as y`, `--x: #{$v}`,
  range media queries) and drop the rest of the file at an error. A `Style`
  node (`DECLARES_STYLE` from the file) is made for each class (`kind: class`),
  id, custom property definition (`--x: …`, `@property --x`) and rule
  (`kind: rule`, with `selector`, `line`, `endLine` and the enclosing `atRule`;
  at most 5 000 rules per file). A rule `SELECTS_STYLE` the classes and ids of
  its selector. A class or id is one node per file, at its first selector.
  Nested rules expand `&` (`&__item` in `.nav` is the class `nav__item`) and
  descendants; names built at compile time (`.a-#{$x}`, `@{x}`), placeholders
  (`%x`), keyframe steps and `@font-face` / `@page` blocks are not nodes, and
  neither are classes inside a mixin body that starts with `&-` (no parent
  to expand). `@extend` is not a link. Classes of a `.module.css` file carry
  `scope: module` and `:global(.x)` / `:global .x` ones `scope: global`.
- `var(--x)` in a style file is `USES_STYLE` from the file (`line`, `match`:
  `file` when the file defines `--x`, otherwise `name`) to the definitions of
  `--x`: the ones in the same file, else every definition of that name in the
  project (the cascade decides which applies, the graph cannot). A custom
  property defined nowhere in the scan (a third-party theme, JS `setProperty`)
  has no target; uses in JS, templates and inline `style` attributes are not
  read.
- `.proto` files are read by the line reader in `languages/plain/proto.ts` into
  `Service` (`name`, `package`, `fullName`, `line`; `DECLARES_SERVICE` from
  the file), `Rpc` (`HAS_RPC` from its service: `name`, `service`, `package`,
  `request`, `response` as written, `clientStreaming`, `serverStreaming`,
  `line`) and `Message` (`DECLARES_MESSAGE`, top-level messages only: nested
  messages, enums, fields and options are not nodes) nodes, and an `Import`
  per `import "x.proto"`.
  - Imports resolve beside the importing file, from the scan root, or to the
    one file whose path ends with the import path (the closest when several
    do), since the include roots (`protoc -I`, buf modules) are not known.
    Well-known imports (`google/protobuf/empty.proto`) and unfound ones stay
    unresolved and are not counted.
  - `RPC_REQUEST` / `RPC_RESPONSE` link an rpc to its messages the way
    protobuf scopes names: from the rpc's own package outwards (`a.b.Req`,
    `a.Req`, `Req`), or as written when qualified or leading with a dot.
    `google.protobuf.*` and other types no scanned `.proto` declares are not
    linked.
  - Go: `RPC_SERVED_BY` links an rpc to the generated server interface
    (`UserServer`, found through the `grpc.ServiceDesc` of the generated
    `_grpc.pb.go` whose `ServiceName` is the rpc's `package.Service`, and only
    when that descriptor lists the method) and `RPC_IMPLEMENTED_BY` to the
    method of each struct that implements the interface, the `Unimplemented…`
    stub aside. A service without generated Go code in the scan, a different
    package spelled in `ServiceName`, and clients (calls through
    `Invoke` / `NewStream` already resolve to the implementations) get no rpc
    link. Other languages' generated code is not read. `list_rpcs` returns
    each rpc with its messages, `servedBy` and `implementations`; an rpc
    whose generated Go server declares it with no implementation has
    `servedBy` and an empty `implementations`.
- SQL files (`.sql`) are read by a scanner of their own
  (`languages/plain/sql-schema.ts`; the vendored sql grammar rejects valid
  code) into `Table` nodes (`library: sql`, `kind: table` or `view`,
  `declaredIn` and `line` of the `CREATE`, `columns`, `indexes`, and
  `migrations`: each change as `{ file, line, order, change }`).
  - Read: `CREATE [TEMP] TABLE` (columns with type, nullability, `PRIMARY KEY`,
    `UNIQUE`, `REFERENCES` / `FOREIGN KEY`, inline and as table constraints;
    `CREATE TABLE … AS`, `LIKE` and `PARTITION OF` have no columns),
    `CREATE [MATERIALIZED] VIEW` (columns only when listed), `CREATE
    [UNIQUE] INDEX`, `ALTER TABLE` (`ADD [COLUMN]`, `DROP COLUMN`, `RENAME
    COLUMN`, `RENAME TO`, `ALTER COLUMN … TYPE | SET NOT NULL | DROP NOT
    NULL`, MySQL `MODIFY` / `CHANGE`, `ADD CONSTRAINT` primary key, unique and
    foreign key), `DROP TABLE | VIEW | INDEX`, MySQL `RENAME TABLE`.
    Statements are applied in order and what stands at the end is the table:
    a dropped table is not a node (its history is not kept), a renamed one is
    under its new name. Not read: triggers, functions, procedures, sequences,
    grants, `INSERT` and other data, `CHECK` expressions, `DEFAULT` values and
    the columns a view selects; `$$ … $$` bodies, strings and comments are
    skipped, so DDL inside a function declares nothing. Dialect-specific
    DDL outside the list is skipped, not an error.
  - Order: dump and schema files (`schema.sql`, `structure.sql`, anything not
    named like a migration) first, `order` 0, then migrations (`migrations/`
    folders, `0001_x.sql`, `20240101120000_x.up.sql`, Flyway `V3__x.sql`,
    Prisma `migrations/<version>_<name>/migration.sql`) by the number their
    name or, for `migration.sql`, folder starts with, `order` 1, 2, … in
    that sequence; a migration without a number goes after the numbered
    ones, by path. `.down.sql` files and `down/` folders are skipped, and so
    is everything after a `-- +goose Down` or `-- +migrate Down` line.
    Rails `db/migrate/*.rb` and ORM migration code (Knex, TypeORM, Alembic,
    Django) are not read.
  - Merging: a table is matched by name, ignoring case and schema
    (`public.users` and `Users` are one table; two schemas with the same
    table name are not told apart). A table that code already declares (an
    ORM model, a Prisma schema, a query string: any `Table` node of kind table
    or view) is not duplicated: it keeps its columns, gets the SQL ones it
    lacks, `declaredIn` when it had none, and the `migrations` and `indexes`.
    Names that differ (a Prisma model `Account` mapped to `accounts` without
    `@@map`) are two tables. Files over 1 MB are not read.
  - `list_tables` returns `indexes` and `migrations`, and a column's
    `references` (`orgs.id`); `library: sql` selects the tables only SQL
    files declare.
- `<style>` blocks of `.vue`, `.svelte` and `.astro` files are read like style
  sheets (`lang` of css, scss or less; `sass`, `stylus` and `src=` blocks are
  not) and declared by the file. Their classes carry `scope: module`
  (`<style module>`), `scoped` (Vue `scoped`, every Svelte and Astro style
  except `is:global`) or none; `:global(.x)` is global.
- `USES_STYLE` also links a function, component or file to a class
  (`line`, `match`, `expression`): from the `Component` a function defines
  (React, Preact, Solid, class components: the method's class), else from the
  `Function`, else the `File`; `.vue` / `.svelte` / `.astro` templates and
  Angular `templateUrl` files link from their component, an Angular inline
  `template` from its component, other HTML from the file.
  - `match: "module"`: `styles.btn` and `styles["btn"]` of a default or
    namespace import of a style file, and Vue's `$style.btn` (to the file's
    `<style module>`). Exact: only a class the file declares is linked, and
    `const { btn } = styles`, `useCssModule()` and named imports are not read.
  - `match: "import"` and `"name"` are matches by name only: the literal
    names of `className="a b"` / `class=`, `classList`, a conditional,
    `&&` or `||` of strings, an array, a static template literal, and the
    string and object-key arguments of `clsx`, `classnames`, `classNames`,
    `cn`, `cx`, `twMerge`, `twJoin`, `cc` and `classcat`; Vue `:class` /
    `v-bind:class`; Svelte `class="a {b}"` and `class:name`; Astro `class` and
    `class:list`; Angular `class`, `[class.x]`, `[class]` and `[ngClass]`
    (read in every `.html` file). Names built at run time (`btn-${size}`,
    `class="a-{b}"`, `{{ x }}`) and variables are not read; a ternary or
    `&&` operand that is a variable names nothing. A class of a style sheet
    the file imports, directly or through `@import` / `@use`, or of the file's
    own `<style>`, is `import`; with none of those the global classes of
    that name anywhere in the project are `name` (at most 20: more than that
    is too ambiguous and links nothing). Classes of `.module.css` files and
    scoped styles are never matched by name from another file. A `CSS` file
    loaded by an HTML `<link>`, a bundler entry or a framework config the
    scan does not read has no `import` link, so its classes only match as
    `name`. Utility classes (Tailwind) have no rule in the project and link
    nothing.
- MCP: `find_references` and `impact_of` take `.class`, `#id` and
  `--custom-property` as `symbol` (`file` narrows to the sheets it matches),
  and `impact_of` takes a style file alone (every class, id and custom
  property it declares). `find_references` lists the rules whose selector
  holds the class or id (`rule`) and the uses (`component-use`,
  `function-use`, `file-use`, `var`) with `detail` (`styles.btn, module
  match`); name matches from a sheet the file does not import are
  `possible: true`. `impact_of` returns `styles`, `users`, `rules`, the
  components that use them and render them (`components`, with depth) and the
  `pages` that render those; for a custom property, also the files that
  import the style files using it (`importers`) and their components. A
  plain name is still a function, class or store: a class is asked as
  `.name`. Tailwind utilities and classes only built at run time are not in
  the graph, so an empty answer is not proof that nothing uses a class.
- `@import`, `@use`, `@forward`, `url()`, CSS Modules `composes: a from "./x"`
  and `@value a from "./x"` are `Import` nodes of the file, resolved to `File`
  like JS imports: relative to the style sheet; Sass and Less add the
  extension and find the partial (`_name.scss`) and a folder's `_index` /
  `index`. `@use "x" as y` keeps the alias. Not imports: URLs, `data:` URIs,
  `url(#id)`, root-relative paths (`/fonts/x.woff2`), `~package` paths,
  `sass:` modules, paths with interpolation or variables, and
  `composes … from global`. A bare Sass name that is not found beside the
  sheet (a package in `node_modules`, an `includePaths` folder) is left
  unresolved and not counted; Sass `loadPaths` and webpack aliases are not
  read. A `url()` or `@import` with `?query` or `#fragment` links the file
  without it.
- JS/TS imports of styles, JSON and images, `new URL("./x.png", import.meta.url)`
  and HTML `<link href>` / `<script src>` resolve to the `File`. A `new URL`
  of a path without an extension (a directory alias such as
  `new URL("./src", import.meta.url)`) and a `src` or `href` with a template
  placeholder (`%PUBLIC_URL%`, `{{ x }}`, `<%= x %>`, `${x}`) are not imports.
  Root-relative paths (`/favicon.ico`), URLs and
  Markdown links are not followed.
- `--max-files` limits code files only; the other files are always kept.
- `get_file_outline` reports a file's `language` and `sourceType`;
  `architecture_overview` and the code counts of the graph summary
  (`files.code`) leave non-code files out, while `files.total` and the
  `languages` list include them.
- `search_symbols`, `find_definitions` and `list_exports` filter by
  `sourceType` and `language` of the declaring file. `find_references` and
  `find_callers` do not: their rows are use sites, which may sit in other
  files than the declaration, and the tool list is near its 19 000 character
  limit. Filter their `file` column afterwards, or call `get_file_outline`.

## Review Process

- Smoke reports include empty `falsePositiveFindings`,
  `falseNegativeFindings`, and `notes` arrays under `semanticSamples.review`.
  Manual review findings should be copied there first, then promoted into this
  backlog when they recur or affect large repositories.
- Before starting each long-term feature, run the release-readiness baseline
  and check whether any limitation above changes the feature design.
