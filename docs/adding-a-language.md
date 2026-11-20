# Adding a Language

Core names no language, so a language is a set of integrations registered in a
`CoreIntegrationRegistry`. This guide walks through every piece, in the order
you would write them. The running example is the toy language in
[`tests/helpers/toy-plugin.ts`](../tests/helpers/toy-plugin.ts): a `.toy` file
where `fn name` declares a function, `call name` calls one and `use name`
imports another `.toy` file. It is a complete plugin that lives outside
`src/core`. Read it first; it is under 100 lines.

There are two ways to add a language:

- **In the repository.** You add `src/integrations/languages/<id>/`, register
  everything in `src/composition/default-registry.ts`, and complete the
  repository steps (grammar, fixtures, goldens, samples, bench labels, UI).
- **Outside the repository.** You build a registry the way the toy plugin does
  and pass it to the scan. Steps 2 to 6 apply; the repository steps do not.
  See [Using a registry from outside](#using-a-registry-from-outside).

Only the parser and the descriptor are required. Every other piece is optional
and adds one kind of fact: calls, imports, inheritance, unused exports,
framework facts, graph properties.

## 1. Grammar

Skip this step if the language is not parsed with tree-sitter (the toy parser
reads lines).

Grammars are prebuilt WebAssembly files in `vendor/grammars/`, built from
pinned npm versions by `scripts/build-grammars.mjs`.

1. Add an entry to the `grammars` array in `scripts/build-grammars.mjs`:
   `{ name: "go", package: "tree-sitter-go", version: "0.25.0", dir: "." }`.
   Pin an exact version. `dir` is the grammar directory inside the package
   (`"."` unless the package holds several).
2. Build only that grammar: `npm run grammars:build -- <name>`. This writes
   `vendor/grammars/<name>.wasm` and updates `vendor/grammars/manifest.json`
   with its sha256. Commit both. Building one grammar fails if the manifest
   was made with a different `tree-sitter` CLI; rebuild all then.
3. Add the name to the `GrammarName` union in
   `src/integrations/languages/syntax/tree-sitter.ts`. That file is the only
   importer of `web-tree-sitter`; parsers call `parseSyntaxTree(grammar, ...)`
   or `parseSyntaxTreeSkippingErrors(grammar, ...)` from it (see
   `src/integrations/languages/go/parser.ts`).
4. `tests/grammars.test.ts` checks the files against the manifest. It fails if
   a `.wasm` is not listed or its hash differs.

`web-tree-sitter` stays the only runtime dependency.

## 2. The descriptor

A `LanguageDescriptor`
([`src/core/contracts/language-descriptor.ts`](../src/core/contracts/language-descriptor.ts))
says which files are written in the language and whether they are read as code.

```ts
export const toyDescriptor: LanguageDescriptor = { id: "toy", code: true, extensions: [".toy"] };
```

- `id` is the value of `File.language`, the key of the parser and the name a
  `concentrate.json` extension override uses (`{ "extensions": { ".tz": "toy" } }`).
- `code: true` means the parser reads declarations, imports and calls. A
  language with `code: false` only produces a `File` node.
- Optional: `fileNames`, `matchFileName`, `fallback`, `version` (part of the
  parse cache fingerprint), `refine` (a per-scan hook that may change a file's
  language, as C++ does for `.h`), and file conventions: `testFile`,
  `generatedFile`, `supportFile`, `lockfiles`, `ignoredPatterns`,
  `ignoredInDirectory`. Conventions apply to every file in the project, not
  only files of this language.
- `displayName` is optional and defaults to `id`. The MCP unused-exports note
  uses it for the language name.

Register it:

```ts
registry.registerLanguage(toyDescriptor);
```

Registering an id again replaces the descriptor.

In the repository, put the descriptor in
`src/integrations/languages/<id>/descriptor.ts` as an exported
`readonly LanguageDescriptor[]` (see `go/descriptor.ts`, exported as
`goLanguages`) and add it to the list in `createDefaultCoreIntegrationRegistry`
in `src/composition/default-registry.ts`. Order matters there: when two
descriptors claim the same extension or file name, the later one wins.

The `isXFile` helpers in `src/integrations/languages/file-kind.ts` are built
from descriptors with `createLanguageFileMatcher(...descriptors)`
(`src/core/scan/language.ts`). Add one for your language if integration code
needs to ask "is this a `<id>` file". Outside the repository, use
`fileMatchesLanguage(descriptors, fileId)` from the same module.

## 3. The parser

An `ILanguageParser`
([`src/core/contracts/language-parser.ts`](../src/core/contracts/language-parser.ts))
turns one file into a `ParsedSourceFile`: a file node id, nodes and
relationships. Its `language` is the descriptor id. `version` is optional;
bump it when the parse output changes, because it is part of the parse cache
fingerprint.

```ts
export function createToyParser(version?: string): ILanguageParser {
  return {
    language: "toy",
    ...(version ? { version } : {}),
    async parse(rootPath, filePath) {
      const relativePath = path.relative(rootPath, filePath);
      const fileNodeId = `file:${relativePath}`;
      const nodes: GraphNode[] = [{ id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language: "toy", /* ... */ } }];
      // ...
        if (keyword === "fn" && name) {
          const id = `${fileNodeId}:function:${name}`;
          nodes.push({ id, label: "Function", properties: { name, qualifiedName: name, line: index + 1 } });
          relationships.push({ from: fileNodeId, to: id, type: "DEFINES_FUNCTION", properties: {} });
```

What the resolvers rely on:

- The first node is the `File` node, with `path`, `relativePath` and
  `language`.
- A function is a `Function` node linked from its file with
  `DEFINES_FUNCTION`.
- A call site is a `Call` node (`name`, `expression`, `callee`, `receiver`,
  `line`, `columnNumber`) linked from its enclosing function with `CALLS`.
- An import is an `Import` node whose `source` is the imported specifier,
  linked from its file with `IMPORTS`.

Register it with `registry.registerLanguageParser(parser)`. There is one
parser per language: registering the same language again replaces it. A code
language without a parser fails `tests/contracts.test.ts`.

In the repository, the parser lives in
`src/integrations/languages/<id>/parser.ts` (examples: `go/parser.ts`,
`rust/parser.ts`) and is registered in the parser list of
`default-registry.ts`.

### Contributors (framework and project facts)

Facts that come from several files or from a framework (routes, dependency
injection, environment variables, data access) are added after parsing by an
`ISemanticContributor`
([`src/core/contracts/semantic-contributor.ts`](../src/core/contracts/semantic-contributor.ts)):

- `id`: unique in the registry; registering a duplicate throws.
- `version`: optional, part of the parse cache fingerprint.
- `dependsOn`: ids of contributors that must run first (topological order,
  stable on registration order; an unknown id or a cycle throws).
- `contribute(graph, rootPath, report, files, settings)`: reads and adds to
  the graph.
- `prepare` and `finish`: optional hooks that run once per scan; `finish` also
  runs when a step failed.

```ts
registry.registerSemanticContributor(contributor);
```

Examples: `src/integrations/frameworks/go/` (routes, gRPC, entry points) and
`src/integrations/frameworks/rust/`. The toy plugin has none.

### Project manifests

If the language declares packages in an ecosystem file (`package.json`,
`pyproject.toml`), register an `IProjectManifestReader`
(`src/core/contracts/project-manifest.ts`) with
`registry.registerProjectManifestReader(reader)`. Examples:
`src/integrations/languages/js-ts/project.ts` and
`src/integrations/languages/python/project.ts`. Core builds the package graph
from what the readers declare.

## 4. Resolvers

Resolution links the nodes the parser produced across files. Each resolver has
a `supports(fileId)` test, and for calls and imports the first registered
resolver that supports the file wins. A call in a file that no call resolver
supports goes through the default name and import lookup in
`src/core/scan/resolution/`.

### Calls

An `ILanguageCallResolver`
([`src/core/contracts/call-resolver.ts`](../src/core/contracts/call-resolver.ts))
builds a session once, then maps each `Call` node to the declarations it
reaches.

```ts
export const toyCallResolver: ILanguageCallResolver = {
  id: "toy",
  supports: (fileId) => fileId.endsWith(".toy"),
  createSession(graph) {
    const byName = new Map(graph.nodesWithLabel("Function").map((node) => [String(node.properties.name), node.id]));
    return (call) => {
      const target = byName.get(String(call.properties.callee));
      return target ? [{ functionId: target }] : [];
    };
  },
};
```

Register with `registry.registerCallResolver(toyCallResolver)`. Each result is
a `ResolvedCallTarget`: `functionId`, plus an optional `via` (`interface`,
`trait`, `override`...) when the match is not direct. The scan writes a
`CALL_RESOLVES_TO` relationship for each. Examples:
`src/integrations/languages/{go,python,rust,cpp}/resolvers.ts`.

### Imports

An `ILanguageImportResolver`
([`src/core/contracts/import-resolver.ts`](../src/core/contracts/import-resolver.ts))
maps each `Import` node to the files it reaches.

```ts
export const toyImportResolver: ILanguageImportResolver = {
  id: "toy",
  supports: (fileId) => fileId.endsWith(".toy"),
  async createSession({ fileIdByRelativePath }) {
    return (_node, _importerFileId, source) => {
      const target = fileIdByRelativePath.get(`${source}.toy`) ?? fileIdByRelativePath.get(`src/${source}.toy`);
      return { fileIds: target ? [target] : [], expected: true };
    };
  },
};
```

- `createSession(context)` receives an `ImportResolutionContext`: the graph,
  `rootPath`, every file id by relative path, the importing file of each
  import, and `addWarning` for a config file that could not be read. It runs
  once, the first time an import of a supported file is seen, so read project
  config (a `go.mod`, a `tsconfig.json`) there. Set
  `sessionWithoutImports: true` only if the session annotates files or reports
  config problems even when nothing imports.
- The session returns `{ fileIds, expected }`. `fileIds` is every file the
  import reaches (a Go import is every file of a package). An empty list means
  unresolved, which counts against the scan only when `expected` is true; set
  it to false for external packages and system headers.

Register with `registry.registerImportResolver(toyImportResolver)`.
`src/integrations/resolution/imports.ts` only dispatches to the resolvers and
adds the `RESOLVES_TO` edges; no language logic lives there. Built-in
resolvers: `src/integrations/languages/{plain,rust,cpp,python,go,js-ts}/import-resolver.ts`,
registered in `default-registry.ts` in the order that decides which one wins.

### Inheritance

An `ILanguageInheritanceResolver` (same file as the call resolver) adds
`EXTENDS` and `IMPLEMENTS` after the default name lookup:
`addRelationships(graph, context)` gets an `InheritanceContext` with the
indexed classes, interfaces and imports and a `resolveNamedNode` helper. Set
`ownsClassesIn(fileId)` to take a file's classes away from the default lookup
when the language resolves bases its own way.

```ts
registry.registerInheritanceResolver(resolver);
```

Inheritance resolvers all run, in registration order; they do not compete.
Examples: `src/integrations/languages/{go,python,rust,cpp}/resolvers.ts`. The
toy language has no classes, so it has none.

## 5. Graph schema extension

The graph schema is data (`src/core/graph/schema.ts`). If the language needs
properties or tables the base schema lacks, declare a `GraphSchemaExtension`:

```ts
export const goGraphSchema: GraphSchemaExtension = {
  id: "go-language",
  nodeProperties: [
    { label: "Variable", after: "stringTemplate", properties: { goType: "STRING", goConstructor: "STRING" } },
  ],
};
```

An extension can add `nodeTables`, `relationshipTables`, `nodeProperties` and
`relationshipProperties`. Property types are `STRING`, `INT64` and `BOOLEAN`.
`after` places new properties after an existing one (missing or unknown means
at the end). Register it with `registry.registerGraphSchema(extension)`. Ids
are unique, and an extension that conflicts with the schema so far (a type
change, an unknown table) throws at registration, not at the first write.

Notes:

- The store takes its schema from the registry the scan used, and a store of
  another schema is rewritten, not patched.
- Node labels you add are not part of the `GraphNodeLabel` union, so plugin
  code writes them with a cast.
- In the repository, put the extension in
  `src/integrations/languages/<id>/schema.ts`, add it to the schema list in
  `default-registry.ts`. `tests/graph-schema.test.ts` pins the merged default
  schema to the frozen snapshot `tests/fixtures/graph-schema.snapshot.json`,
  so a change to the default schema means updating that snapshot on purpose,
  and the order of the list fixes the property order in it. Existing stores
  of another schema are rewritten on the next scan.

The toy plugin needs no extension.

## 6. Unused-export rules

`find_unused_exports` runs a core algorithm (export index, imports through
barrels, calls and class links). A language supplies an `IUnusedExportRules`
([`src/core/contracts/unused-rules.ts`](../src/core/contracts/unused-rules.ts))
to say what its public API is.

```ts
export const toyUnusedRules: IUnusedExportRules = {
  id: "toy",
  languages: ["toy"],
  supports: (file) => file.endsWith(".toy"),
  note: "Toy: every function counts as public API.",
};
```

Required: `id`, `languages` (the `File.language` values judged) and
`supports(file)`. Everything else is optional: `unitOf` (files that belong
together, such as a package or a header/source pair), `isPublicApi`,
`binaryReason`, `entryReason`, `packageEntries`, `skipReasons`,
`wildcardImportUsesWholeFile`, `createSession` (per-analysis state such as
name mentions in other units) and `note`.

Register with `registry.registerUnusedExportRules(rules)`. Ids are unique.
Registration order is the order of the language paragraphs in the MCP
`find_unused_exports` note, and the note's language list is derived from the
registered rules. Each language name in it is the descriptor's `displayName`,
or the id when that is not set.

Examples: `src/integrations/languages/{js-ts,go,rust,python,cpp}/unused.ts`.

## 7. Tests, fixtures and golden files

In the repository:

1. **Parser fixture.** `tests/contracts.test.ts` iterates the registered
   parsers and fails for a code language that has no entry in its
   `parserFixtures` map. Add a fixture directory under `fixtures/` with a
   small file in your language and an entry
   `<id>: { root: "<fixture-dir>", file: "<path-in-it>" }`. The test checks the
   parser returns a `File` node plus at least one more node.
2. **Fixture projects.** Each directory under `fixtures/` is a small project
   that `tests/golden.test.ts` scans. Add one that exercises declarations,
   imports, calls and, if you have them, inheritance and unused exports.
3. **Golden files.** The graph of each fixture is pinned in
   `tests/golden/fixtures/<name>.jsonl`. Write the golden for a new fixture
   with `npm run golden:update`, then read the file: every node and
   relationship in it should be one you can explain. Run `golden:update` only
   for intended changes, and review the whole diff, not just the new files; an
   unexplained golden diff is a regression. See
   [tests/golden/README.md](../tests/golden/README.md).
4. **Unit tests** for the resolvers and rules, written like
   `tests/plugin-language.test.ts` (descriptor, parser and call resolver),
   `tests/plugin-host.test.ts` (workers) and
   `tests/unused-rules-registry.test.ts` (unused rules).
5. The file-kind helpers are covered in `tests/file-kind.test.ts`.

Before sending a change, run `npm run typecheck && npm test`.

## 8. Samples

Fixtures are small; real repositories find what they miss.

1. Add the pinned repositories to `scripts/samples.json`:
   `{ "name": "internet-<id>-<project>", "suite": "internet", "repo": "https://github.com/...", "sha": "<commit>" }`.
   Pin a full commit sha. Optional fields: `golden: true` (the sample also has
   a golden graph in `tests/golden/samples/`), `paths` (scan only these
   directories), `exclude`, `continueOnError`.
2. Fetch with `npm run samples:fetch -- --suite all`
   (`scripts/fetch-samples.mjs`). Samples land in `.concentrate/samples/<name>`.
3. Add a row to the table in
   [sample-repositories.md](sample-repositories.md) with the repository and
   pinned commit.
4. For samples marked `golden`, `npm run test:samples` requires their goldens;
   write them with `npm run golden:update` after the samples are fetched.

## 9. Bench labels

Accuracy is measured against hand-written labels, never against the tool's own
output ([accuracy.md](accuracy.md) explains how they are made).

- Labels are `bench/labels/<sample>.json`, one file per labeled sample.
  `bench/labels/ky.json` shows the call labels: the files to cover and, for
  each call site, the callee and the target file and name (`null` for an
  unresolved call).
- Read the sample's source to decide each target; do not copy from Concentrate.
- Run `npm run bench:accuracy -- --details` before and after your change, and
  record the new numbers and the sample in [accuracy.md](accuracy.md).

## 10. UI highlight map

The web UI highlights source with `highlight.js`, loading only the languages
Concentrate reads. In `ui/web/src/lib/highlight.ts`:

1. Add the file extensions to the `LANGUAGES` map, pointing at a highlight.js
   language name (`rs: "rust"`).
2. If that highlight.js language is not already loaded, import it in `load()`
   (`highlight.js/lib/languages/<name>`) and add it to the object passed to
   `registerLanguage`.

Without an entry the UI shows the source as plain escaped text. This step is
cosmetic; nothing in the scan depends on it.

## Using a registry from outside

A plugin does not touch the repository. It builds a registry and hands it to
the scan, as `createToyRegistry` does:

```ts
export function createToyRegistry(version?: string): CoreIntegrationRegistry {
  const registry = createDefaultCoreIntegrationRegistry();
  registry.registerLanguage(toyDescriptor);
  registry.registerLanguageParser(createToyParser(version));
  registry.registerCallResolver(toyCallResolver);
  registry.registerUnusedExportRules(toyUnusedRules);
  registry.registerImportResolver(toyImportResolver);
  return registry;
}
```

Start from `createDefaultCoreIntegrationRegistry()` to add to the built-in
languages, or from `createEmptyCoreIntegrationRegistry()` for a registry of
your own. Both and the contracts are exported from `src/api.ts`.

Pass the registry to the scan with `createScanDependencies(registry)`
(`buildCodeGraph(path, options, deps)`) or hand it to
`scanIntoStore(path, options, onProgress, registry)`. Nothing on that path
uses the default registry.

**Workers.** Large scans parse on worker threads. A worker can only parse your
language if it can build the same registry, so export `createRegistry()` from
an ES module and pass the module to the scan:

```ts
export function createRegistry(): CoreIntegrationRegistry {
  return createToyRegistry();
}

const deps = createScanDependencies(createToyRegistry(), { registryModule: toyModule });
```

`registryModule` is a `file:` URL or an absolute path. `createRegistry()` must
build an equivalent registry every time. Without a registry module a custom
registry parses on the main thread; a worker that cannot load the module dies
and the pool falls back to the main thread. `tests/plugin-host.test.ts` covers
both cases, using a `parsedIn` property that shows which thread parsed each
file.

**Parse cache.** The cache fingerprint includes `kind:id@version` of every
registered integration. Give your parser, resolvers and contributors a
`version` and bump it when their output changes.

## Checklist

Plugin (outside the repository):

- [ ] Descriptor registered with `registerLanguage`.
- [ ] Parser registered with `registerLanguageParser`; it emits `File`,
      `Function`, `Call` and `Import` nodes as in step 3.
- [ ] Call resolver registered with `registerCallResolver`.
- [ ] Import resolver registered with `registerImportResolver`.
- [ ] Inheritance resolver registered with `registerInheritanceResolver`, if
      the language has classes.
- [ ] Contributors registered with `registerSemanticContributor`, if the
      language has framework facts.
- [ ] Schema extension registered with `registerGraphSchema`, if it adds
      properties or tables.
- [ ] Unused-export rules registered with `registerUnusedExportRules`, with a
      `note`.
- [ ] `version` set on the parser and the integrations, bumped on output
      changes.
- [ ] `createRegistry()` exported from a module and passed as `registryModule`
      so workers parse the language.
- [ ] A test that scans a small project end to end.

In the repository, in addition:

- [ ] Grammar entry in `scripts/build-grammars.mjs`, `.wasm` and
      `vendor/grammars/manifest.json` committed, name added to `GrammarName`.
- [ ] `src/integrations/languages/<id>/` with `descriptor.ts`, `parser.ts` and
      the pieces above, all registered in
      `src/composition/default-registry.ts`.
- [ ] `isXFile` helper in `src/integrations/languages/file-kind.ts`, if needed.
- [ ] Schema extension added to the default registry and
      `tests/fixtures/graph-schema.snapshot.json` updated on purpose.
- [ ] `parserFixtures` entry in `tests/contracts.test.ts` and a fixture
      directory under `fixtures/`.
- [ ] Golden files from `npm run golden:update`, reviewed line by line.
- [ ] Samples in `scripts/samples.json` and
      [sample-repositories.md](sample-repositories.md).
- [ ] Hand-written labels in `bench/labels/<sample>.json`;
      `npm run bench:accuracy -- --details` before and after; numbers in
      [accuracy.md](accuracy.md).
- [ ] Extensions added to `LANGUAGES` in `ui/web/src/lib/highlight.ts`.
- [ ] `npm run typecheck && npm test && npm run build` pass.
