# Accuracy report

How often the graph is right about routes, call targets, data access and UI
components,
measured against hand-written labels on the pinned sample repositories
(`scripts/samples.json`).

```bash
npm run samples:fetch
npm run bench:accuracy -- [--sample name] [--details] [--json out.json]
```

`--details` lists every false positive (FP), false negative (FN) and wrong
route path. The latest run is in
[`bench/results/accuracy-0.1.0-2026-10-29.json`](../bench/results/accuracy-0.1.0-2026-10-29.json).

## Labels

The labels are in [`bench/labels/<sample>.json`](../bench/labels). They were
written by reading each sample's source, not derived from Concentrate's
output, so the tool is not graded against itself. Call sites were listed from
the bare tree-sitter syntax tree (every call and `new` expression in the
chosen files); every target was decided by reading the code.

| Kind | Samples | Scope |
| --- | --- | --- |
| Routes | express, fastify, nestjs-starter, internet-node-express-realworld | every route declared with a literal path in the scoped files; tests excluded |
| Calls | express, fastify, nestjs-starter, ky, internet-node-express-realworld | every call site in 4–9 chosen files per sample |
| Data access | internet-node-express-realworld, internet-nest (05-sql-typeorm, 06-mongoose, 13-mongo-typeorm, 14-mongoose-base, 22-graphql-prisma) | the services; the standing samples have no data layer |
| Components, renders | internet-react-realworld (the RealWorld "Conduit" React + Redux frontend) | `src/components/`: every component and every element that renders one |

Rules:

- **Routes.** `{ method, path, file, line }` with the full path, mount
  prefixes included. Middleware mounts (`app.use`) are not routes. Express
  examples that build paths at runtime (`examples/resource`,
  `examples/route-map`, `examples/mvc`) are listed under `routes.computed` in
  the label file and not scored.
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
  (`connectOrCreate` inside an `article.create`) are not labeled.
- **Components.** `{ file, name, line }` for every React component: function
  and class components, including a class that extends another component
  (`ProfileFavorites extends Profile`).
- **Renders.** `{ file, parent, line, child, childFile }` once per JSX
  element that renders a component of the repository. Rendering a module's
  `connect(...)(X)` default export counts as rendering X. Library elements
  (`<Link>`, `<Route>`), components passed as props (`<Route
  component={Home}>`) and elements in class methods other than `render()`
  (which render library components only) are not labeled.

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

## Results (2026-10-30, schema 45)

### Routes

| Sample | Labels | TP | FP | FN | Precision | Recall | Full path |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 59 | 59 | 0 | 0 | 100.0% | 100.0% | 100.0% (59/59) |
| fastify | 14 | 14 | 0 | 0 | 100.0% | 100.0% | 100.0% (14/14) |
| internet-node-express-realworld | 20 | 20 | 0 | 0 | 100.0% | 100.0% | 100.0% (20/20) |
| nestjs-starter | 1 | 1 | 0 | 0 | 100.0% | 100.0% | 100.0% (1/1) |
| **all** | 94 | 94 | 0 | 0 | **100.0%** | **100.0%** | **100.0% (94/94)** |

### Call resolution

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 28 | 8 | 0 | 20 | 100.0% | 28.6% |
| fastify | 6 | 6 | 0 | 0 | 100.0% | 100.0% |
| internet-node-express-realworld | 24 | 24 | 0 | 0 | 100.0% | 100.0% |
| ky | 13 | 13 | 0 | 0 | 100.0% | 100.0% |
| nestjs-starter | 2 | 2 | 0 | 0 | 100.0% | 100.0% |
| **all** | 73 | 53 | 0 | 20 | **100.0%** | **72.6%** |

Labels counts calls with a project target. Another 310 call sites are labeled
`null`, and 35 are `dynamic`.

### Data access

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-nest | 17 | 17 | 0 | 0 | 100.0% | 100.0% |
| internet-node-express-realworld | 26 | 26 | 0 | 0 | 100.0% | 100.0% |
| **all** | 43 | 43 | 0 | 0 | **100.0%** | **100.0%** |

### Components

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-react-realworld | 32 | 31 | 0 | 1 | 100.0% | 96.9% |

### Component renders

| Sample | Labels | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| internet-react-realworld | 29 | 23 | 0 | 6 | 100.0% | 79.3% |

## What the misses are

Precision is 100% everywhere: no route, call target, data access, component
or render the graph states is wrong. (The one wrong call target, a bare `resolve()` bound by `var
resolve = path.resolve` in express's `lib/view.js`, is left unresolved since
#48.) Every labeled route is found: routes registered inside plugin
functions and `build()` factories (#41), fastify-decorators controllers
(#42), and apps and routers recognized by the factory that created them
(`apiv1 = express.Router()`, `main = express()`, #43), each with its full
path: mount prefixes are followed across files, through chained and
default-exported routers (`export default Router().use('/api', api)`) and
`app.use('/api/v1', require('./api_v1'))` (#44). Recall is where the gaps
are, and they cluster:

- **Objects assembled at runtime.** Express's `app` gets its methods from
  `lib/application.js` through `merge-descriptors`; the 20 `app.set` /
  `app.use` / `app.listen` labels in the examples point there. They are left
  in the labels as the ground truth a reader would expect, and are all of
  express's remaining call misses, and so all misses left in the call labels.
  (Default imports, #45; constructors and static methods, #46; and
  module-level calls, `require('./x')(...)` and `module.exports = …`
  defaults, #47, resolve now.)

- **Components behind a higher-order wrapper.** The six missed renders
  are all of `export default connect(...)(X)` modules: the element renders
  the module's default export, which the graph does not know is X. The one
  missed component is `ProfileFavorites`, a class that extends another
  component class (`Profile`) instead of `React.Component`.

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
