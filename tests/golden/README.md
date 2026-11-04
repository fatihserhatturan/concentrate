# Golden data

Golden files pin Concentrate's observable output so that large rewrites (the
storage engine in Phase 2, the parsers in Phase 3) can be checked mechanically.

| Directory | Contents | Produced by |
| --- | --- | --- |
| `fixtures/` | One normalized graph per directory under `fixtures/` | `tests/golden.test.ts` |
| `samples/` | Normalized graphs of the pinned standing samples and of the internet samples marked `"golden": true` in `scripts/samples.json` (the Go backends and the Go full-stack sample, `.jsonl.gz`) | `tests/golden-samples.test.ts` |
| `queries/` | Cypher statements issued by the MCP tools and the rows they returned | `tests/golden-queries.test.ts` |
| `cypher/` | Cypher conformance corpus: hand-written queries and the rows (or error class) Kuzu returned | `tests/golden-cypher.test.ts` |

## Format

Graph goldens are JSONL. The first line is a `{"kind":"report"}` record with scan
status, file counts, failures and warnings. Every following line is a
`{"kind":"node"}` or `{"kind":"rel"}` record from `normalizeGraph()`
(`src/core/graph/normalize.ts`): the scan root is replaced with `<root>`, and
records and property keys are sorted, so the files are identical on every machine.

## Updating

```bash
npm run golden:update
```

Only update goldens for an intended behavior change, and explain the diff in the
PR description. A golden diff that nobody can explain is a regression.

## Query recordings

`queries/<fixture>.json` (and `queries/samples/<sample>.json.gz`) hold one entry
per case in [`query-cases.json`](query-cases.json):

```json
{ "tool": "find_callers", "args": { "name": "add" },
  "calls": [ { "method": "query", "cypher": "MATCH ...", "rows": [ ... ] } ],
  "output": { ... } }
```

- `calls` lists every `IQueryEngine` call the tool made, in issue order:
  `query` (whitespace-collapsed Cypher and the rows the store returned), `stats`, or
  `schemaVersion`. The Phase 2 engine must return the same rows when it replays
  each `cypher`.
- `output` is the parsed JSON text the MCP tool returned to the client.
- `templates.json` pins the distinct query shapes (literals replaced by `$str` /
  `$num`). A new tool or filter that the cases do not cover shows up as a diff
  here.

The recordings pin current behavior. A tool fix that changes results must show
up as a golden diff and be explained in the PR.

## Cypher conformance corpus

[`cypher/cases.json`](cypher/cases.json) lists hand-written queries that cover
the Cypher subset Concentrate supports: patterns, variable-length paths,
`OPTIONAL MATCH`, `WHERE`, `WITH`, aggregation, ordering and error cases.
`cypher/<fixture>.json` holds the result of every case on that fixture, recorded
from Kuzu 0.11.3: `{ "rows": [...] }`, or `{ "error": "parser" | "binder" | "runtime" | "unsupported" }`.

- Rows are compared as a sorted multiset unless the case sets `"ordered": true`.
- Cases with `expectError` were not run against Kuzu. They are writes and
  features outside the read-only subset (`unsupported`), or places where we
  deliberately report an error that Kuzu does not (explained in `note`).
- Kuzu was removed in Phase 2. These files are now the reference for the
  built-in engine (`src/adapters/store/`, see [docs/cypher.md](../../docs/cypher.md)):
  `golden:update` never rewrites them, so a semantic change shows up as a
  failing test. A new case needs its expected result written by hand, checked
  against Cypher semantics and the rules above.

