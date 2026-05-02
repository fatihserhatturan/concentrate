# Development Plan

The current goal is to turn Concentrate from a working scanner demo into a reliable multi-language code graph indexer.

## Milestone 2: Reliable JS/TS Indexer

1. [x] Add directory graph support.
   - Add `Directory` nodes.
   - Represent containment as `Repo -> Directory`, `Directory -> Directory`, and `Directory -> File`.
   - Keep stable directory IDs based on project-relative paths.

2. [x] Add scan reporting and error tolerance.
   - Track discovered files, supported files, skipped files, parsed files, and failed files.
   - Add `--continue-on-error`.
   - Print a concise summary at the end of every scan.

3. [x] Add import resolution.
   - Keep existing `File -> Import` extraction.
   - Resolve relative imports to real source files when possible.
   - Add `Import -> RESOLVES_TO -> File`.

4. [x] Improve call graph modeling.
   - Keep raw call expression nodes.
   - Prepare the model for future `Call -> RESOLVES_TO -> Function` relationships.
   - Avoid claiming semantic resolution until it exists.

5. [x] Add JSONL export.
   - Export `nodes.jsonl`.
   - Export `relationships.jsonl`.
   - Use the export format as a debug and migration path.

6. [x] Add fixture-based tests.
   - Add small JS/TS fixture projects.
   - Assert graph counts and selected relationships.
   - Cover imports, classes, functions, and call expressions.

## Milestone 3: Multi-Language Indexing

7. [x] Add Python parser support.
   - Detect `.py` files.
   - Extract Python imports, functions, classes, and calls.
   - Resolve simple relative imports such as `from .utils import utility`.
   - Cover the behavior with fixture tests.

8. [x] Formalize language parser registry.
   - Introduce a `LanguageParser` interface.
   - Register JS/TS and Python parsers through a common registry.
   - Keep `parseSourceFile` as a thin registry lookup.
   - Make adding Go/Rust a small adapter task.

9. [x] Harden Python import resolution.
   - Resolve `from package.module import x`.
   - Resolve `from . import utils`.
   - Resolve `from ..core import thing`.
   - Handle `import package.module as alias`.
   - Account for `__init__.py` package files.
   - Add fixture tests for each case.

10. [x] Add JS/TS path and package resolution.
   - Read `tsconfig.json` `baseUrl` and `paths`.
   - Resolve aliases such as `@/utils/foo`.
   - [ ] Read `package.json` `exports`, `main`, and `types` where useful.
   - Add fixtures for path aliases and package-style imports.

11. [x] Add Go parser support.
   - Detect `.go` files.
   - Extract package declarations, imports, functions, methods, and structs.
   - Extract basic call expressions.
   - Add Go fixture tests.

12. [x] Add Rust parser support.
   - Detect `.rs` files.
   - Extract `use`, `mod`, `fn`, `struct`, and `impl` structures.
   - Extract basic call expressions.
   - Add Rust fixture tests.

13. [x] Add scan progress and parser concurrency.
   - Parse files with bounded concurrency.
   - Add progress output for large repositories.
   - Add `--max-files`, `--include`, and `--exclude` options.
   - Keep output deterministic despite concurrency.

14. [x] Add schema version marker.
   - Add a schema/version metadata table or node.
   - Record graph schema version during scan/export.
   - Prepare for future migrations instead of reset-only behavior.

## Milestone 4: Graph Completeness

The goal of this milestone is to close the most significant gaps in graph accuracy so that
the tool produces a faithful structural model of real-world codebases.

### 4a — JS/TS parser completeness

15. [x] Extract arrow functions and function expressions in JS/TS.
   - Extract `const foo = () => {}` (arrow_function assigned to variable).
   - Extract `const foo = async () => {}`.
   - Extract `export const foo = () => {}` (exported arrow).
   - Extract `const foo = function() {}` (function expression).
   - Use the variable name as the function name when available.
   - Add fixture tests for each form.

16. [x] Add per-language dedicated parser instances.
   - Create one `new Parser()` per language, language pre-set at module init.
   - Remove all `setLanguage()` calls from the parse hot path.
   - Prevents fragility if an `await` is ever introduced between language switch and parse.

### 4b — Graph model accuracy

17. [x] Attribute class methods to their class, not their file.
   - Add `DEFINES_METHOD` relationship: `Class → Function`.
   - Remove the `File → DEFINES_FUNCTION` edge for methods that belong to a class.
   - Apply to all languages: JS/TS `method_definition`, Python class body
     `function_definition`, Go `method_declaration`, Rust `impl` methods.
   - Add `className` property to Function nodes for quick lookup.
   - Update fixture tests to assert the new relationship.

18. [x] Add function and class metadata properties.
   - `isExported: boolean` on Function and Class nodes (JS/TS `export` keyword,
     Python leading `_` convention, Go uppercase name, Rust `pub`).
   - `isAsync: boolean` on Function nodes (JS/TS `async`, Python `async def`,
     Rust `async fn`).
   - Enables queries such as "list all exported async functions".
   - Add fixture assertions for each property.

### 4c — Test coverage

19. [x] Add per-parser unit test files.
   - One test file per language: `javascript.test.ts`, `typescript.test.ts`,
     `python.test.ts`, `go.test.ts`, `rust.test.ts`.
   - Each test asserts extracted node counts, node properties (`name`, `kind`,
     `isExported`, `isAsync`), and key relationships.
   - Cover the arrow function forms added in task 15 and method attribution from task 17.
   - These tests should have caught the arrow-function gap before it shipped.

### 4d — Query and output ergonomics

20. [x] Add `--format` option to the `query` command.
   - `--format json` (default, current behavior): pretty-printed JSON array.
   - `--format table`: ASCII table via `console.table`.
   - `--format csv`: header row + comma-separated values, suitable for piping.
   - Keep the default as `json` for scriptability.

### 4e — Import resolution completeness

21. [x] Add Go project-internal import resolution.
   - Detect the module name from `go.mod`.
   - Resolve `module/pkg/foo` imports to local `.go` files.
   - Add `RESOLVES_TO` edges for internal packages.
   - Add fixture and test.

22. [x] Add Rust crate-relative import resolution.
   - Resolve `use crate::module` and `use super::module` to local `.rs` files.
   - Add `RESOLVES_TO` edges for crate-internal paths.
   - Add fixture and test.

## Milestone 5: Graph Depth and Queryability

The goal of this milestone is to make the graph genuinely useful for code intelligence queries
by closing the most critical structural and semantic gaps.

### 5a — Call resolution

23. [x] Resolve call expressions to their target Function nodes.
   - Add `RESOLVES_TO` relationship: `Call → Function`.
   - For same-file calls: match by function name within the same file.
   - For cross-file calls: use import graph to locate the defining file, then match by name.
   - Apply to all languages.
   - Enables queries such as "list all callers of function X".

### 5b — TypeScript-specific constructs

24. [x] Extract TypeScript interfaces, type aliases, and enums.
   - Add `Interface` node label for `interface` declarations.
   - Add `TypeAlias` node label for `type X = ...` declarations.
   - Add `Enum` node label for `enum` declarations.
   - Add `DEFINES_INTERFACE`, `DEFINES_TYPE_ALIAS`, `DEFINES_ENUM` relationships from File.
   - Extract `isExported` on each.
   - Add fixture and tests.

### 5c — Inheritance and implementation relationships

25. [x] Extract class inheritance and interface implementation.
   - Add `EXTENDS` relationship: `Class → Class`.
   - Add `IMPLEMENTS` relationship: `Class → Interface`.
   - Apply to JS/TS (`extends`, `implements` clauses) and Python (base class list).
   - Go struct embedding and Rust trait `impl` as stretch goals.
   - Add fixture and tests.

### 5d — Re-export tracking

26. [x] Track JS/TS re-exports.
   - Handle `export { foo } from './bar'` — add `IMPORTS` + `RESOLVES_TO` edges.
   - Handle `export * from './bar'` — add a wildcard re-export edge.
   - Prevents import chain gaps at barrel files.
   - Add fixture and tests.

### 5e — Package boundary resolution

27. [x] Resolve `package.json` exports, main, and types fields.
   - Read `package.json` `exports`, `main`, and `types` to resolve package-style imports.
   - Fills the gap left by task 10 for Node.js package boundaries.
   - Add fixture and tests.

### 5f — Visibility granularity

28. [x] Add `visibility` property to Function and Class nodes.
   - TypeScript: `"private"`, `"protected"`, `"public"` (default `"public"`).
   - Rust: `"pub"`, `"pub(crate)"`, `"pub(super)"`, `"private"`.
   - Python: `"private"` (leading `_`), `"dunder"` (leading `__`), `"public"`.
   - Go: `"exported"` (uppercase) or `"unexported"`.
   - Supersedes the boolean `isExported` for finer-grained queries.
   - Update fixture assertions.

## Milestone 6: JS/TS Graph Fidelity

The goal of this milestone is to close the most significant structural gaps in the JS/TS
graph so that queries reflect the real API surface and dependency structure of a codebase.

### 6a — Named import/export binding resolution (P0)

29. [x] Parse named import and export bindings into discrete graph edges.
   - Break `import { foo, bar } from './utils'` into individual `IMPORTS_NAME` edges
     from File to the target Function/Class/TypeAlias nodes.
   - Track the local alias when present: `import { foo as f }`.
   - Fix the call resolver ambiguity: currently a name-only call scans all imported files
     for any function with that name; use the binding list to narrow to the correct target.
   - Add fixture and tests.

### 6b — Dynamic import support (P0)

30. [x] Capture `import()` expressions as Import nodes with resolution.
   - Detect `import(specifier)` call expressions (not `import_statement`).
   - Emit an `Import` node with `isDynamic: true`.
   - Add `IMPORTS` and `RESOLVES_TO` edges using the existing resolution pipeline.
   - Cover `await import('./foo')`, `React.lazy(() => import('./Page'))`, and
     `import(variable)` (unresolvable — record as unresolved).
   - Add fixture and tests.

### 6c — CommonJS require() support (P0)

31. [x] Treat `require()` calls as Import nodes in JS/CJS files.
   - Detect `require(specifier)` call expressions in `.js` / `.cjs` / `.mjs` files.
   - Emit an `Import` node with `isCjs: true`.
   - Add `IMPORTS` and `RESOLVES_TO` edges using the existing resolution pipeline.
   - Handle destructured form: `const { foo } = require('./utils')`.
   - Add fixture and tests.

### 6d — Function signature extraction (P1)

32. [x] Add parameter list and return type to Function nodes.
   - Add `parameters` property: JSON-serialized array of `{ name, type }` objects.
   - Add `returnType` property: the declared return type as a string, or `null`.
   - Apply to JS/TS function declarations, arrow functions, and method definitions.
   - Add fixture and tests.

### 6e — Class field extraction (P1)

33. [x] Extract class fields and properties as nodes.
   - Add a `Field` node label: `id`, `name`, `typeName`, `isStatic`, `isReadonly`,
     `visibility`, `line`.
   - Add `DEFINES_FIELD` relationship: `Class → Field`.
   - Cover TypeScript `public/private/protected/readonly` modifiers.
   - Cover private class fields (`#name`).
   - Add fixture and tests.

### 6f — Module-level constant and variable export extraction (P2)

34. [x] Extract exported module-level constants and variables.
   - Add a `Variable` node label: `id`, `name`, `kind` (`const`/`let`/`var`),
     `isExported`, `line`.
   - Add `DEFINES_VARIABLE` relationship: `File → Variable`.
   - Skip variable declarators that are arrow functions or function expressions
     (already captured as Function nodes).
   - Add fixture and tests.

### 6g — Decorator extraction (P2)

35. [x] Extract decorators on classes and methods.
   - Add a `Decorator` node label: `id`, `name`, `expression`, `line`.
   - Add `HAS_DECORATOR` relationship: `Class → Decorator` and `Function → Decorator`.
   - Apply to TypeScript class decorators and method decorators.
   - Add fixture and tests.

## Milestone 7: JS/TS Graph Fidelity — Remaining Gaps

The goal of this milestone is to close the structural gaps identified after Milestone 6
was completed. These are real-world patterns that appear frequently in JavaScript and
TypeScript codebases but are not yet captured in the graph.

### 7a — Class expression support (P0)

36. [x] Extract `class_expression` assigned to variables as Class nodes.
   - Detect `variable_declarator` whose value is `class_expression`.
   - Create a `Class` node using the variable name, linked via `DEFINES_CLASS`.
   - Extract methods, fields, and decorators from the class body as with `class_declaration`.
   - Add fixture and tests.

### 7b — Constructor parameter properties (P0)

37. [x] Extract TypeScript constructor parameter properties as Field nodes.
   - Detect `constructor` `method_definition` parameters with accessibility modifiers
     (`public`, `private`, `protected`, `readonly`).
   - Emit a `Field` node for each such parameter with the correct visibility and type.
   - Link via `DEFINES_FIELD` from the parent Class node.
   - Add fixture and tests.

### 7c — Local named re-export tracking (P1)

38. [x] Track `export { foo }` statements that re-export local bindings.
   - Detect `export_statement` nodes that have a named export list but no source string.
   - Emit a `RE_EXPORTS` relationship from File to the target Function/Class/Variable node
     by resolving the exported name against nodes already defined in the same file.
   - Add fixture and tests.

### 7d — CommonJS module.exports support (P1)

39. [x] Capture `module.exports` assignments as export metadata.
   - Detect `module.exports = { ... }` and `module.exports.foo = ...` assignment patterns.
   - For object-literal form: emit a `Variable` node (or reuse an existing node) per key.
   - Mark each exported binding with `isExported: true`.
   - Add fixture and tests.

### 7e — Getter and setter kind tracking (P2)

40. [x] Distinguish getter and setter methods from regular methods.
   - Read the `kind` field on `method_definition` nodes (`"get"`, `"set"`, `"method"`).
   - Store the value as a `methodKind` property on Function nodes.
   - Update fixture assertions.

### 7f — Abstract class and method tracking (P2)

41. [x] Track the `abstract` modifier on classes and methods.
   - Add an `isAbstract: boolean` property to Class and Function nodes.
   - Set it to `true` when the TypeScript `abstract` keyword is present.
   - Update fixture assertions.

## Milestone 8: Node.js Backend Framework Fidelity

The goal of this milestone is to make the graph accurately represent real-world Node.js
backend codebases: Express, Fastify, Koa, NestJS, and similar frameworks. All gaps below
were identified by analysing the JS/TS parser against common Node.js patterns.

### 8a — Module-level call expressions (P0)

42. [x] Capture call expressions at module (program) scope as Call nodes.
   - Currently `createCallNodes` only runs inside a `isFunctionNode` scope boundary.
   - Walk the top-level `program` children and emit Call nodes for any `call_expression`
     found directly at module level.
   - Attach them via a new `MODULE_CALLS` relationship: `File → Call`.
   - Covers `app.use(router)`, `app.listen(PORT)`, `fastify.register(plugin)`,
     `mongoose.connect(uri)`, `NestFactory.create(AppModule)`, etc.
   - Add fixture and tests.

### 8b — Inline route handler functions (P0)

43. [x] Extract anonymous/inline functions passed as arguments as Function nodes.
   - Detect `call_expression` arguments whose value is `arrow_function` or
     `function_expression` (i.e. inline handlers).
   - Emit a `Function` node with a synthetic name derived from the call context
     (e.g. `<router.post /users handler:2>`).
   - Add a `DEFINES_FUNCTION` relationship: `File → Function`.
   - Add `PASSED_TO` relationship: `Function → Call` to link handler to its route call.
   - Covers `router.get('/users', async (req, res) => { ... })`,
     `fastify.route({ handler: async (req, reply) => { ... } })`.
   - Add fixture and tests.

### 8c — `new` expression call nodes (P1)

44. [x] Capture `new_expression` calls in the call graph.
   - Extend `createCallNodes` (and module-level walk from task 42) to also emit a
     Call node for `new_expression` nodes.
   - Set `callee` to the constructor name, `receiver` to `null`.
   - Covers `new PrismaClient()`, `new EventEmitter()`, `new Bull('queue', cfg)`.
   - Add fixture and tests.

### 8d — `tsconfig.json` `extends` chain resolution (P1)

45. [x] Resolve `extends` inheritance in tsconfig parsing.
   - When `parseTsconfig` encounters an `"extends"` field, read the parent config
     file and merge `baseUrl` and `paths` (child values take precedence).
   - Support both relative paths (`./tsconfig.base.json`) and package references
     (`@tsconfig/strictest`).
   - Repeat recursively until no further `extends` is found.
   - Fixes alias resolution for all NestJS and TypeScript monorepo projects.
   - Add fixture and tests.

### 8e — NestJS decorator argument extraction (P1)

46. [x] Parse decorator arguments into a structured `args` property on Decorator nodes.
   - Add `args` property (JSON-serialized array of string values) to the Decorator schema.
   - Extract string literal, number literal, and identifier arguments from the decorator
     call expression.
   - Enables queries such as
     `MATCH (d:Decorator {name: 'Controller'}) RETURN d.args` → `["users"]`.
   - Covers `@Controller('users')`, `@Get(':id')`, `@Module({...})`,
     `@InjectRepository(User)`.
   - Update schema version and fixture assertions.

### 8f — Chained method call receiver resolution (P1)

47. [x] Handle chained call expressions in `analyzeMemberCallExpression`.
   - When the receiver part of a member expression is itself a call expression
     (e.g. `app.use(cors()).use(json())`), extract the root identifier (`app`) as
     the effective receiver instead of returning the full sub-expression string.
   - Prevents receiver values like `"app.use(cors()).use(json())"` from being
     unresolvable in the call resolution index.
   - Add unit tests for nested chain inputs.

### 8g — `import type` distinction (P2)

48. [x] Add `isTypeOnly` property to Import nodes.
   - Detect `import type { ... }` statements (tree-sitter node has `"type"` keyword
     before the import clause).
   - Set `isTypeOnly: true` on the emitted Import node.
   - Enables filtering runtime dependencies from type-only dependencies in queries.
   - Update schema version and fixture assertions.

### 8h — Variable initialiser call linkage (P2)

49. [x] Link module-level variable initialisers to their Call nodes.
   - When a `variable_declarator` at module level has a `call_expression` or
     `new_expression` as its value, emit the corresponding Call node and add a
     `INITIALIZED_BY` relationship: `Variable → Call`.
   - Covers `const app = express()`, `const db = new PrismaClient()`,
     `const router = Router()`.
   - Add fixture and tests.

### 8i — `export default` anonymous expression nodes (P2)

50. [x] Emit a placeholder node for anonymous `export default` expressions.
   - Detect `export_statement` whose child is a bare expression (not a named
     declaration): `export default router`, `export default express()`.
   - Emit a `Variable` node with `name: "default"`, `kind: "export_default"`,
     `isExported: true`.
   - Add `DEFINES_VARIABLE` relationship: `File → Variable`.
   - Add fixture and tests.

## Milestone 9: Node.js Backend Semantic Graph

The goal of this milestone is to move beyond structural JS/TS extraction and add
backend-aware graph semantics for Express, Fastify, NestJS, and similar Node.js
server frameworks. Frontend frameworks such as React, Vue, and Angular are
intentionally out of scope for this milestone.

### 9a — Route node model (P0)

51. [x] Add first-class `Route` nodes and route relationships.
   - Add a `Route` node label with properties such as `method`, `path`, `line`,
     `framework`, and `handlerName`.
   - Add relationships such as `DECLARES_ROUTE`: `File → Route` and
     `ROUTE_HANDLED_BY`: `Route → Function`.
   - Keep existing `Call`, `MODULE_CALLS`, and `PASSED_TO` nodes/relationships;
     route nodes should enrich backend semantics without replacing raw structure.
   - Update schema version and Kuzu schema tables.
   - Add fixtures and tests.

### 9b — Express/Koa router method extraction (P0)

52. [x] Extract Express/Koa-style route method calls into `Route` nodes.
   - Detect `app.get`, `app.post`, `app.put`, `app.patch`, `app.delete`,
     `app.options`, `app.head`, `router.get`, `router.use`, and similar calls.
   - Extract literal path arguments from calls such as
     `router.get('/users/:id', handler)`.
   - Link inline handlers via existing synthetic `Function` nodes when available.
   - Link referenced handlers such as `router.get('/users', listUsers)` to same-file
     function declarations when possible.
   - Add Express and Koa fixtures covering inline handlers, referenced handlers,
     middleware chains, and `router.use`.

### 9c — Router mount path extraction (P0)

53. [x] Model router and middleware mounting semantics.
   - Detect `app.use('/api', router)`, `app.use('/admin', adminRouter)`, and
     `router.use('/nested', childRouter)`.
   - Add a relationship such as `MOUNTS`: `Variable/File/Route → Variable`
     or another appropriate endpoint once the graph shape is finalized.
   - Store mount path and line information as relationship properties.
   - Combine mount paths with route paths in queries where possible, without
     mutating the original route path.
   - Add fixtures and tests for nested routers.

### 9d — Fastify route and plugin semantics (P1)

54. [x] Extract Fastify route declarations and plugin registrations.
   - Detect shorthand calls such as `fastify.get('/users', handler)` and
     `fastify.post('/users', options, handler)`.
   - Detect object-form declarations such as
     `fastify.route({ method: 'GET', url: '/users', handler })`.
   - Extract `fastify.register(plugin, { prefix: '/api' })` as plugin/mount
     semantics with prefix metadata.
   - Link inline and referenced handlers where possible.
   - Add Fastify fixtures and tests.

### 9e — NestJS controller route semantics (P1)

55. [x] Convert NestJS controller and method decorators into `Route` nodes.
   - Use `@Controller('users')` as the controller base path.
   - Use method decorators such as `@Get(':id')`, `@Post()`, `@Put()`,
     `@Patch()`, and `@Delete()` to create route nodes.
   - Link each route to the decorated class method via `ROUTE_HANDLED_BY`.
   - Preserve raw `Decorator` nodes and `HAS_DECORATOR` / `HAS_METHOD_DECORATOR`
     relationships.
   - Add NestJS controller fixtures and tests.

### 9f — NestJS module/provider graph (P1)

56. [x] Extract NestJS module metadata into provider/import/export relationships.
   - Parse object-literal arguments passed to `@Module({ ... })`.
   - Capture `imports`, `providers`, `controllers`, and `exports` arrays when
     they contain identifiers.
   - Add relationships such as `MODULE_IMPORTS`, `MODULE_PROVIDES`,
     `MODULE_CONTROLS`, and `MODULE_EXPORTS` after finalizing the exact schema.
   - Add fixtures for simple modules and modules with imported feature modules.

### 9g — Constructor injection and `this.service` call resolution (P1)

57. [x] Resolve constructor-injected services to class methods.
   - Track TypeScript constructor parameter properties such as
     `constructor(private readonly usersService: UsersService)`.
   - Link `this.usersService.findAll()` calls to `UsersService.findAll()` when
     the service class is present in the scanned graph.
   - Add a relationship such as `INJECTS`: `Class → Class` or a field-level link,
     depending on the existing field model.
   - Add NestJS service/controller fixtures and tests.

### 9h — Instance variable method resolution (P2)

58. [x] Resolve method calls through variables initialized with `new`.
   - Use `Variable -[:INITIALIZED_BY]-> Call(new ClassName)` to infer the variable
     instance type when the class is defined locally.
   - Resolve `service.run()` to the `run` method on `Service`.
   - Support simple same-file and imported class cases first.
   - Add fixtures for manually constructed services, repositories, and clients.

### 9i — Object-literal handler extraction (P2)

59. [x] Extract handler functions nested in object literals.
   - Detect handlers in patterns such as
     `fastify.route({ handler: async (request, reply) => {} })`.
   - Detect middleware/route config objects containing `preHandler`, `handler`,
     or framework-specific callback keys.
   - Emit synthetic `Function` nodes and link them to the owning call or route.
   - Add fixtures and tests.

### 9j — Backend smoke-test repositories (P2)

60. [x] Add backend sample repository smoke scans.
   - Add sample repository entries for at least one Express app, one Fastify app,
     and one NestJS app.
   - Track last scan commands and expected high-level counts in
     `docs/sample-repositories.md`.
   - Run smoke scans after backend-semantic changes to catch real-world parser
     regressions.

## Milestone 10 — Deeper Node.js backend semantics

This milestone extends the non-frontend JavaScript/TypeScript analysis beyond
basic declarations, imports, routes, and dependency injection. Frontend
framework-specific semantics such as React, Vue, Angular, Svelte, and similar
component models remain intentionally out of scope.

### 10a — Middleware and request lifecycle graph (P0)

61. [x] Model middleware chains and request lifecycle ordering.
   - Capture Express/Koa/Fastify middleware registrations such as `app.use`,
     `router.use`, route-level middleware arrays, and Fastify `preHandler`
     hooks.
   - Add relationships that preserve execution order between middleware,
     handlers, and error handlers.
   - Distinguish application-level middleware, router-level middleware, and
     route-level middleware where the framework pattern makes that clear.
   - Add fixtures for auth, validation, controller, and error-handler chains.

### 10b — Composed route path resolution (P0)

62. [x] Resolve composed backend route paths across mounts and constants.
   - Combine router mount paths with child route paths for simple literal and
     constant-backed patterns.
   - Resolve path constants declared in the same file or imported from local
     modules when the value is a string literal.
   - Preserve both raw route path and resolved full path on route nodes or
     route-related relationships.
   - Add real-repo smoke expectations that catch regressions in resolved path
     counts.

### 10c — CommonJS export and require edge cases (P1)

63. [x] Expand CommonJS module semantics.
   - Capture `exports.foo = ...`, `module.exports.foo = ...`,
     `Object.assign(exports, ...)`, and common factory-export patterns.
   - Track conditional `require()` calls as imports while marking them as
     conditional or dynamic when the condition cannot be resolved statically.
   - Improve call resolution through imported CommonJS object properties.
   - Add fixtures for mixed ESM/CommonJS packages and legacy Node services.

### 10d — Config and environment usage graph (P1)

64. [x] Model backend config and environment access.
   - Extract `process.env.NAME` and `process.env["NAME"]` references into graph
     nodes or properties that can be queried by file, function, and route.
   - Link simple config exports to their consumers when values are imported from
     local config modules.
   - Parse relevant `package.json` metadata and common TypeScript/Node config
     files as project context.
   - Add fixtures for feature flags, database URLs, and environment-gated code.

### 10e — Event, job, and realtime entrypoints (P1)

65. [x] Add non-HTTP backend entrypoint semantics.
   - Detect `EventEmitter` listeners, queue consumers, cron jobs, scheduler
     callbacks, and websocket handlers in common Node.js patterns.
   - Add first-class entrypoint nodes or typed relationships that identify the
     trigger kind and handler function.
   - Support simple Bull/BullMQ, node-cron, NestJS scheduler, and socket.io
     patterns before expanding to additional libraries.
   - Add fixtures that prove handler functions are reachable from these
     entrypoints.

### 10f — ORM and data-access semantics (P1)

66. [x] Link backend handlers to data-access models and operations.
   - Detect common Prisma, TypeORM, Sequelize, Knex, and Mongoose call patterns.
   - Model simple operations such as create, read, update, delete, query, and
     transaction boundaries when they are visible in code.
   - Link route handlers, services, and repository methods to the data models or
     collections they access.
   - Add fixtures for service/repository layers and direct model usage.

### 10g — Test, fixture, and production-code classification (P2)

67. [x] Classify test/support files separately from production graph content.
   - Mark files matching common patterns such as `*.test.ts`, `*.spec.ts`,
     `__tests__`, `fixtures`, `mocks`, and test setup files.
   - Preserve test graph data while allowing queries and stats to filter by
     production, test, fixture, or generated/support code.
   - Include classification metadata in sample repository smoke stats.
   - Add fixtures covering common test layouts.

## Milestone 11 — Production readiness from real-repo validation

This milestone captures the gaps found while scanning the standing sample
repositories plus small, medium, and large real-world Node.js/TypeScript
repositories downloaded on 2026-05-01. The goal is to turn Concentrate from a
strong internal analysis tool into a production-ready scanner that remains fast,
predictable, and diagnosable on large repositories.

### 11a — Bulk graph writes (P0)

68. [x] Replace single-row Kuzu writes with a bulk writer.
   - Batch node and relationship writes through JSONL/CSV import or a
     transaction-oriented writer instead of one `CREATE` per record.
   - Preserve existing schema versioning, physical relationship mapping, and
     stats behavior.
   - Benchmark against the large Nest validation repository and record before
     and after timings.
   - Keep the current writer path available as a simple fallback until the bulk
     writer is proven stable.

### 11b — Partial graph output on parse failures (P0)

69. [x] Make `--continue-on-error` write partial graphs when parsing fails.
   - Ensure supported files that parse successfully are still written to the
     target database or export directory when some files fail.
   - Keep failed file details in the scan report and return an appropriate
     non-zero exit code or explicit partial-success status.
   - Add regression coverage using the Nest decorator spec parse failures found
     during real-repo validation.
   - Document the difference between fail-fast, continue-with-partial-graph, and
     clean successful scans.

### 11c — Automated smoke validation runner (P0)

70. [x] Add a one-command smoke validation runner for sample repositories.
   - Run standing samples and internet validation samples through scan, stats,
     and targeted semantic queries.
   - Assert expected schema version, parsed/failed file counts, route counts,
     entrypoint counts, environment/config counts, data model counts, and file
     classification counts.
   - Serialize a machine-readable smoke report for CI and a compact human
     summary for local development.
   - Run queries serially per Kuzu database to avoid known per-database lock
     contention.

### 11d — Config parser hardening (P1)

71. [x] Harden project config parsing for real-world TypeScript/Node projects.
   - Treat unreadable or malformed `tsconfig`, `jsconfig`, and package metadata
     as warnings instead of scanner-fatal errors where possible.
   - Expand JSONC handling to cover common comments, trailing commas, glob
     strings, path aliases, and workspace config inheritance.
   - Add fixtures based on real validation cases such as `@/*`, `src/*`, and
     `**/*.spec.ts` path/glob strings.
   - Surface config warnings in the scan report without hiding successfully
     parsed source files.

### 11e — Workspace and package graph (P1)

72. [x] Model monorepo workspaces and package boundaries.
   - Detect npm, pnpm, yarn, and common package workspace layouts.
   - Add package/workspace nodes or properties and link files, configs, and
     internal imports to their owning package.
   - Allow stats and queries to filter by package as well as production/test/
     fixture/support/generated file class.
   - Validate against the large Nest repository and the Ky sample repository.

### 11f — Deeper data-access resolution (P1)

73. [x] Improve ORM and repository data-access resolution.
   - Trace ORM clients through imports, aliases, dependency injection, wrapper
     services, and repository class methods.
   - Link service/repository methods back to concrete Prisma models,
     Mongoose models, Sequelize models, TypeORM repositories, and Knex tables
     when visible.
   - Add false-positive guards for factory and framework APIs that resemble ORM
     model calls.
   - Expand real-repo validation queries for detected data models and accessed
     operations.

### 11g — Semantic accuracy review reports (P2)

74. [x] Add semantic sample reports for routes, entrypoints, config, and data access.
   - Generate top-N route, entrypoint, env/config, and data-access query samples
     after smoke scans.
   - Include file path and line metadata so results can be spot-checked quickly.
   - Track false positives and false negatives discovered during manual review.
   - Use the report to guide follow-up parser and resolver improvements.

### 11h — Kuzu query concurrency and retry behavior (P2)

75. [x] Make Kuzu CLI access friendlier under per-database lock contention.
   - Add retry/backoff for transient Kuzu lock errors in stats and query
     commands.
   - Ensure smoke validation runs same-database queries serially.
   - Document that parallel operations should target different database paths or
     use the smoke runner's queueing behavior.

## Milestone 12 — Pre Long-Term Stabilization

Before starting incremental scanning or MCP server work, freeze a reliable
baseline and make the current production-readiness gaps explicit.

76. [x] Add a release-readiness baseline checklist.
   - Document the exact validation commands required before long-term work:
     typecheck, unit tests, build, standing smoke, and internet smoke.
   - Record the current schema version, smoke report paths, and expected
     high-level counts as the baseline for future architectural changes.
   - Make it clear which generated databases and reports are validation
     artifacts rather than source files.

77. [x] Add a known limitations and semantic review backlog.
   - Summarize current parser/resolver limitations discovered during sample
     scans, especially false-positive and false-negative risks.
   - Group gaps by imports, routes, entrypoints, config/env, data access,
     workspace/package graph, and Kuzu operations.
   - Link each limitation to the long-term goal or follow-up area it blocks.

78. [x] Add a lightweight release candidate verification command.
   - Provide a single npm script that runs the core local validation sequence
     without requiring internet sample repositories.
   - Keep internet smoke validation as an explicit heavier command.
   - Document when to run the lightweight command versus the full smoke suite.

## Long-Term Development Goals

These items require significant architectural work or external integrations and are tracked
separately as future investment areas rather than near-term tasks.

### Incremental Scanning

79. [x] Add scan manifest generation with file content hashes.
   - Produce a deterministic manifest of supported source files with relative
     path, language, size, mtime, and SHA-256 content hash.
   - Persist the manifest from scan/export commands as a validation artifact.
   - Use the manifest as the baseline for future changed-file detection.

80. [x] Compare current files with a previous scan manifest.
   - Detect added, changed, unchanged, and deleted supported source files.
   - Surface incremental eligibility in the scan report without skipping parse
     work yet.
   - Keep full-scan behavior as the default until graph patching exists.

81. [x] Add changed-file-only parse planning.
   - Build a parse plan for `--incremental changed-files` requests.
   - Report added, changed, unchanged, and deleted file sets in the parse plan.
   - Clearly fall back to full scan until unchanged graph slice preservation
     and patching are implemented.

82. [x] Add graph patch updates for incremental scans.
   - Remove stale nodes and relationships for changed or deleted files.
   - Insert updated graph slices for added and changed files.
   - Re-run cross-file finalizers for affected relationship classes.

83. [x] Add incremental scan validation and benchmarks.
   - Add fixtures for add/change/delete file scenarios.
   - Benchmark full versus incremental scans on standing and large samples.
   - Document when incremental scanning is safe to use.

### MCP Server

- Expose the graph as a Model Context Protocol (MCP) tool.
- Allow Claude and other MCP clients to query the code graph directly in natural language.
- Potential tools: `find_callers`, `find_definitions`, `list_exports`, `trace_import_chain`.
- Turns Concentrate into an always-on code intelligence layer for AI-assisted development.

## Current Priority

Milestones 8, 9, 10, 11, and 12 are complete. Incremental Scanning tasks 79
through 83 are complete. Continue with the next long-term development area.
