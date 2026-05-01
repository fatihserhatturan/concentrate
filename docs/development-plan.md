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

51. [ ] Add first-class `Route` nodes and route relationships.
   - Add a `Route` node label with properties such as `method`, `path`, `line`,
     `framework`, and `handlerName`.
   - Add relationships such as `DECLARES_ROUTE`: `File → Route` and
     `ROUTE_HANDLED_BY`: `Route → Function`.
   - Keep existing `Call`, `MODULE_CALLS`, and `PASSED_TO` nodes/relationships;
     route nodes should enrich backend semantics without replacing raw structure.
   - Update schema version and Kuzu schema tables.
   - Add fixtures and tests.

### 9b — Express/Koa router method extraction (P0)

52. [ ] Extract Express/Koa-style route method calls into `Route` nodes.
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

53. [ ] Model router and middleware mounting semantics.
   - Detect `app.use('/api', router)`, `app.use('/admin', adminRouter)`, and
     `router.use('/nested', childRouter)`.
   - Add a relationship such as `MOUNTS`: `Variable/File/Route → Variable`
     or another appropriate endpoint once the graph shape is finalized.
   - Store mount path and line information as relationship properties.
   - Combine mount paths with route paths in queries where possible, without
     mutating the original route path.
   - Add fixtures and tests for nested routers.

### 9d — Fastify route and plugin semantics (P1)

54. [ ] Extract Fastify route declarations and plugin registrations.
   - Detect shorthand calls such as `fastify.get('/users', handler)` and
     `fastify.post('/users', options, handler)`.
   - Detect object-form declarations such as
     `fastify.route({ method: 'GET', url: '/users', handler })`.
   - Extract `fastify.register(plugin, { prefix: '/api' })` as plugin/mount
     semantics with prefix metadata.
   - Link inline and referenced handlers where possible.
   - Add Fastify fixtures and tests.

### 9e — NestJS controller route semantics (P1)

55. [ ] Convert NestJS controller and method decorators into `Route` nodes.
   - Use `@Controller('users')` as the controller base path.
   - Use method decorators such as `@Get(':id')`, `@Post()`, `@Put()`,
     `@Patch()`, and `@Delete()` to create route nodes.
   - Link each route to the decorated class method via `ROUTE_HANDLED_BY`.
   - Preserve raw `Decorator` nodes and `HAS_DECORATOR` / `HAS_METHOD_DECORATOR`
     relationships.
   - Add NestJS controller fixtures and tests.

### 9f — NestJS module/provider graph (P1)

56. [ ] Extract NestJS module metadata into provider/import/export relationships.
   - Parse object-literal arguments passed to `@Module({ ... })`.
   - Capture `imports`, `providers`, `controllers`, and `exports` arrays when
     they contain identifiers.
   - Add relationships such as `MODULE_IMPORTS`, `MODULE_PROVIDES`,
     `MODULE_CONTROLS`, and `MODULE_EXPORTS` after finalizing the exact schema.
   - Add fixtures for simple modules and modules with imported feature modules.

### 9g — Constructor injection and `this.service` call resolution (P1)

57. [ ] Resolve constructor-injected services to class methods.
   - Track TypeScript constructor parameter properties such as
     `constructor(private readonly usersService: UsersService)`.
   - Link `this.usersService.findAll()` calls to `UsersService.findAll()` when
     the service class is present in the scanned graph.
   - Add a relationship such as `INJECTS`: `Class → Class` or a field-level link,
     depending on the existing field model.
   - Add NestJS service/controller fixtures and tests.

### 9h — Instance variable method resolution (P2)

58. [ ] Resolve method calls through variables initialized with `new`.
   - Use `Variable -[:INITIALIZED_BY]-> Call(new ClassName)` to infer the variable
     instance type when the class is defined locally.
   - Resolve `service.run()` to the `run` method on `Service`.
   - Support simple same-file and imported class cases first.
   - Add fixtures for manually constructed services, repositories, and clients.

### 9i — Object-literal handler extraction (P2)

59. [ ] Extract handler functions nested in object literals.
   - Detect handlers in patterns such as
     `fastify.route({ handler: async (request, reply) => {} })`.
   - Detect middleware/route config objects containing `preHandler`, `handler`,
     or framework-specific callback keys.
   - Emit synthetic `Function` nodes and link them to the owning call or route.
   - Add fixtures and tests.

### 9j — Backend smoke-test repositories (P2)

60. [ ] Add backend sample repository smoke scans.
   - Add sample repository entries for at least one Express app, one Fastify app,
     and one NestJS app.
   - Track last scan commands and expected high-level counts in
     `docs/sample-repositories.md`.
   - Run smoke scans after backend-semantic changes to catch real-world parser
     regressions.

## Long-Term Development Goals

These items require significant architectural work or external integrations and are tracked
separately as future investment areas rather than near-term tasks.

### Incremental Scanning

- Avoid full re-scans by tracking file content hashes between runs.
- Only re-parse files whose hash has changed since the last scan.
- Update only the affected nodes and relationships in the graph.
- Critical for large codebases where full scans take too long to be practical.

### MCP Server

- Expose the graph as a Model Context Protocol (MCP) tool.
- Allow Claude and other MCP clients to query the code graph directly in natural language.
- Potential tools: `find_callers`, `find_definitions`, `list_exports`, `trace_import_chain`.
- Turns Concentrate into an always-on code intelligence layer for AI-assisted development.

## Current Priority

Milestone 8 is complete. Begin Milestone 9 with tasks 51–53 (P0: first-class route
nodes, Express/Koa route extraction, and router mount path semantics) before moving to
Fastify, NestJS, and deeper DI/call-resolution work.
