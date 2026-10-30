# Known Limitations and Semantic Review Backlog

This backlog captures known risk areas before long-term architectural work
begins. It is intentionally practical: each item should either guide semantic
review or feed a future long-term task.

## Import Resolution

- Package and workspace resolution covers common npm, pnpm, yarn, `exports`,
  `main`, `types`, `baseUrl`, and `paths` cases, but does not yet model every
  conditional export branch or runtime-specific resolver rule.
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
- Parameter decorators such as `@Param()` or `@InjectRepository()` are recorded
  as `Call` nodes of their method; class and method decorators are `Decorator`
  nodes.
- `INJECTS` comes from constructor parameter properties
  (`constructor(private readonly users: UsersService)`) and from properties
  decorated with `@Inject...()`, recorded as `Field.isInjected`. Constructor
  parameters without an access modifier are not modelled. Every typed field
  still resolves `this.field.method()` calls.
- Found by the accuracy report ([accuracy.md](accuracy.md)), unresolved today:
  - `new X()` of a class with no constructor in its chain (calls resolve to
    functions, so there is nothing to point at);
  - methods of objects assembled at runtime (Express's `app`, mixed in from
    `lib/application.js`).
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
  function the attribute calls, linked when the page itself defines it.
- `customElements.define('x-tag', Class)` becomes a `Component` (framework
  `web-components`); `COMPONENT_DEFINED_BY` links the class only when it is
  declared in the same file.

Blocks or informs: MCP `list_entrypoints` and future backend runtime summaries.

## Config and Environment

- Environment and config links cover direct `process.env` access and visible
  local config exports. Complex schema validators or config factories may need
  additional resolver logic.
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

- Grammars are pinned to the versions the native binding used: javascript
  0.23.1, typescript and tsx 0.23.2, python 0.21.0, go 0.21.2, rust 0.21.0
  (see `vendor/grammars/manifest.json`). Newer syntax that only later grammar
  releases understand produces `ERROR` nodes.
- Inline JSX event handlers create no nodes of their own, so a call inside
  `onClick={() => track()}` is attributed to the enclosing component.
- A JS/TS file with syntax errors produces a partial graph: each statement or
  class member that contains an `ERROR` or `MISSING` node is left out (the
  file is parsed again with that text blanked), and the scan reports a warning
  with the lines left out. A file that stays broken after four rounds fails
  as before. Python, Go and Rust files with syntax errors are still reported
  as failed files (`--continue-on-error` keeps the rest of the scan).

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
  (`{#if}`) and `{expressions}` are not read as code yet, and a component
  rendered in a template is no `RENDERS` relationship yet (Phases 11–15).
  Svelte `$:` reactive statements are labelled statements, so their calls
  have no caller.

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
  not components.
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

## Review Process

- Smoke reports include empty `falsePositiveFindings`,
  `falseNegativeFindings`, and `notes` arrays under `semanticSamples.review`.
  Manual review findings should be copied there first, then promoted into this
  backlog when they recur or affect large repositories.
- Before starting each long-term feature, run the release-readiness baseline
  and check whether any limitation above changes the feature design.
