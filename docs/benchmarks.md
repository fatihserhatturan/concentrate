# Graph store benchmarks

Measured with `npx tsx scripts/bench-store.ts --runs 20` on the four standing
samples (`npm run samples:fetch` first). Parsing runs once per sample and is not
measured, so only the store is timed:

- **Write**: `reset()` + `write()` of the whole graph, at least 5 runs.
- **Tools**: one MCP tool call each (the `common` cases in
  `tests/golden/query-cases.json`), 20 runs after one warm-up.

All numbers are milliseconds, given as p50 / p95.

## Baseline: Kuzu 0.11.3 (before Phase 2)

Apple M4, Node v24.13.0, macOS. Recorded 2026-10-27.

| Sample | Nodes | Rels | Write | graph_stats | find_definitions | list_exports | list_routes | list_entrypoints | list_env_config | list_data_access |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 3281 | 4130 | 2955.6 / 3025.39 | 3.5 / 3.83 | 3.6 / 3.86 | 4.28 / 4.56 | 1.07 / 1.12 | 0.56 / 0.63 | 1.5 / 1.64 | 2.46 / 2.67 |
| fastify | 339 | 392 | 821.89 / 842.38 | 3.41 / 3.96 | 2.95 / 3.2 | 4.2 / 4.44 | 0.63 / 0.68 | 0.58 / 0.68 | 1.41 / 1.52 | 2.36 / 2.59 |
| nestjs-starter | 68 | 95 | 664.7 / 667.83 | 3.49 / 3.82 | 2.85 / 2.97 | 4.12 / 4.32 | 0.64 / 0.78 | 0.56 / 0.74 | 1.34 / 1.5 | 2.36 / 2.56 |
| ky | 5494 | 6926 | 4729.13 / 4978.06 | 3.42 / 3.87 | 3.52 / 3.7 | 4.53 / 4.73 | 0.59 / 0.64 | 0.57 / 0.63 | 1.54 / 1.62 | 2.46 / 2.7 |

Write time is dominated by one `CREATE` statement per node and relationship;
even the 68-node sample pays ~650 ms of schema creation. Phase 2's acceptance
criterion is MCP tool latency equal to or better than this table.

## Built-in store (Phase 2)

Same machine and samples, recorded 2026-10-27 with `--runs 100`. Write is
`reset()` + `write()` including the snapshot commit (gzip segments, atomic HEAD
rename). Tool calls include the per-call HEAD check that lets a running MCP
server pick up a new scan.

| Sample | Nodes | Rels | Write | graph_stats | find_definitions | list_exports | list_routes | list_entrypoints | list_env_config | list_data_access |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 3281 | 4130 | 12.02 / 17.33 | 1.1 / 1.58 | 1.66 / 2.52 | 1.61 / 3.56 | 0.48 / 0.73 | 0.1 / 0.12 | 0.32 / 0.36 | 0.3 / 0.61 |
| fastify | 339 | 392 | 1.36 / 3.06 | 0.35 / 0.42 | 0.41 / 0.61 | 0.56 / 0.66 | 0.09 / 0.11 | 0.08 / 0.09 | 0.23 / 0.27 | 0.22 / 0.25 |
| nestjs-starter | 68 | 95 | 0.53 / 0.63 | 0.23 / 0.26 | 0.3 / 0.37 | 0.44 / 0.52 | 0.09 / 0.11 | 0.09 / 0.11 | 0.24 / 0.27 | 0.21 / 0.24 |
| ky | 5494 | 6926 | 20.73 / 28.33 | 2.11 / 2.35 | 1.31 / 2.09 | 1.03 / 2.53 | 0.09 / 0.1 | 0.09 / 0.1 | 0.26 / 0.3 | 0.23 / 0.28 |

Compared with the Kuzu baseline:

- **Write** is 140–1250× faster (express 2956 → 12 ms, ky 4729 → 21 ms); there
  is no schema to create and no statement per record.
- **Every MCP tool** is faster at p50 and p95 on every sample: 1.3–3× on the
  scan-heavy tools (`graph_stats`, `find_definitions`, `list_exports`) and
  2–10× on the others.
- With `--runs 20`, p95 is effectively the second-slowest call, and a single
  garbage-collection pause can put it above the baseline (seen up to 5 ms for
  express `graph_stats`); use 100 runs to compare tails.
- `node_modules` went from 653 MB to 114 MB; the `kuzu` package alone was 531 MB.

## Parser: native vs WASM

Phase 3a moved parsing from the native `tree-sitter` binding (0.21.1) to
`web-tree-sitter` 0.27.1 with the same grammar versions built to WebAssembly.
Apple M4, Node v24.13.0, macOS, recorded 2026-10-27. Each cell is the median
of 5 full `scan` runs (wall time / peak RSS from `/usr/bin/time -l`), with the
two builds alternating so neither always runs on a warm file cache.

| Sample | Native ms | Native MB | WASM ms | WASM MB | WASM / native |
| --- | ---: | ---: | ---: | ---: | ---: |
| express | 954 | 184 | 481 | 226 | 0.50 |
| fastify | 115 | 102 | 98 | 122 | 0.85 |
| nestjs-starter | 88 | 90 | 81 | 125 | 0.92 |
| ky | 714 | 170 | 354 | 211 | 0.50 |
| internet-node-express-firebase-mongodb | 139 | 104 | 111 | 130 | 0.80 |
| internet-node-express-realworld | 159 | 106 | 120 | 121 | 0.75 |
| internet-nest | 3351 | 287 | 1327 | 305 | 0.40 |

- **Parsing alone is slower on WASM** (all 2091 files of the samples, 4.4 MB:
  native 257 ms, WASM 453 ms). Full scans are still faster because extractors
  read many node properties, and each read is an N-API call on the native
  binding but a plain WebAssembly memory read on web-tree-sitter.
- **Memory** is 15–40 MB higher (the WebAssembly heap). Six scans of
  `internet-nest` in one process level off at about 370 MB RSS; trees are freed
  with `delete()` and do not accumulate.
- **Output is identical**: golden graph, golden query and smoke tests pass
  unchanged, and `internet-nest` gives the same 40488 nodes and 41360
  relationships on both builds.
- **Install**: `npm ci --omit=dev --ignore-scripts` gives a 4.5 MB
  `node_modules` (only `web-tree-sitter`, was 67 MB with the native binding and
  five grammar packages). The vendored grammars add 3.5 MB.

## Parse cache

`npm run benchmark:incremental` (Phase 5), Apple M4, Node v24.13.0, recorded
2026-10-28. In-process `buildGraph` times in milliseconds for a full scan (no
cache), a cold-cache scan (parses everything and writes the cache) and a
warm-cache scan with no file changes. Every warm scan reproduced the full
scan's graph exactly.

| Sample | Files | Full | Cold cache | Warm cache | Full / warm |
| --- | ---: | ---: | ---: | ---: | ---: |
| express | 141 | 333 | 316 | 61 | 5.4× |
| fastify | 18 | 15 | 14 | 3.9 | 3.9× |
| nestjs-starter | 7 | 9.6 | 5.1 | 2.1 | 4.5× |
| ky | 52 | 194 | 205 | 33 | 5.9× |
| internet-node-express-firebase-mongodb | 24 | 28 | 23 | 4.0 | 7.1× |
| internet-node-express-realworld | 39 | 28 | 31 | 5.8 | 4.8× |
| internet-nest | 1714 | 1433 | 1581 | 402 | 3.6× |

- What remains of a warm scan is file discovery, hashing every file for the
  manifest, reading cache entries, and the cross-file passes, which always run
  (about 200 ms of the 400 ms on `internet-nest`).
- A cold-cache scan costs up to 10% more than a full scan for writing entries.
- The two `internet-nest` files that fail to parse are never cached and are
  parsed on every scan.
- From the CLI, `scan` of express goes from 0.49 s to 0.22 s wall time with a
  warm cache.

## Frontend file formats

Phase 10 added the TSX and HTML grammars, partial trees for syntax errors and
markup files (HTML, Vue, Svelte, Astro), whose scripts are parsed from the
file text with the markup blanked out. Per-file parse time with the language
parser (parse plus extraction and framework plugins), median of 200 runs after
20 warm-up runs, Apple M4, Node v24.13.0, recorded 2026-10-30:

| File | Language | Bytes | ms per file |
| --- | --- | ---: | ---: |
| `tsx-components/src/ProductList.tsx` | typescript (TSX grammar) | 873 | 0.58 |
| `syntax-errors/src/orders.ts` (3 statements left out, 4 parses) | typescript | 427 | 0.27 |
| `vanilla-html/index.html` | html | 816 | 0.37 |
| `single-file-components/src/components/CartButton.vue` | vue | 499 | 0.31 |
| `single-file-components/src/components/Total.svelte` | svelte | 372 | 0.23 |
| `single-file-components/src/pages/index.astro` | astro | 618 | 0.38 |
| `single-file-components/src/lib/cart.ts` (plain TS, for comparison) | typescript | 167 | 0.16 |

- A markup file costs one HTML parse plus one JS/TS parse of its scripts, so it
  stays in the range of a plain TS file of the same size.
- A file with syntax errors is parsed once per round (here four times), and
  only those files pay for it.
- The standing samples have no `.tsx`, `.vue`, `.svelte` or `.astro` files, so
  their scan times above are unchanged; a frontend sample comes with Phase 11.

## Parser benchmark and parse workers

`npm run bench:parser` (Phase 3e) builds, then measures `dist/` on every
sample: tree-sitter alone, the language parsers (parse plus extraction, run
once per file), and a full scan without the parse cache, on the main thread
and with the default parse workers. Apple M4, Node v24.13.0, recorded
2026-10-28; medians of 5 runs in milliseconds.

| Sample | Files | KB | Parse | Extract | Scan, main thread | Extract / scan | Scan, workers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 141 | 532 | 63 | 236 | 264 | 89% | 220 (4) |
| fastify | 18 | 18 | 2 | 8 | 10 | 80% | 10 (0) |
| nestjs-starter | 7 | 3 | 0 | 2 | 3 | 67% | 3 (0) |
| ky | 52 | 448 | 51 | 164 | 186 | 88% | 187 (0) |
| internet-node-express-firebase-mongodb | 24 | 40 | 5 | 16 | 18 | 89% | 18 (0) |
| internet-node-express-realworld | 39 | 53 | 6 | 20 | 24 | 83% | 24 (0) |
| internet-nest | 1714 | 3215 | 333 | 1163 | 1417 | 82% | 851 (4) |

- **Per-file work dominates.** Parsing and extraction are 80–90% of a scan;
  tree-sitter itself is about a quarter of that, the rest is walking the trees
  in JavaScript. Cross-file resolvers and semantic contributors are the
  remaining 10–20%.
- **Parse workers.** Files the parse cache does not have are parsed on
  `node:worker_threads` once there are 100 or more of them: up to 4 workers,
  leaving a core for the main thread. `internet-nest` scans 1.7× faster
  (1417 → 851 ms) and `express` 1.2×; more than 4 workers did not help.
  `--workers <n>` sets the count, `--workers 0` parses on the main thread. A
  warm-cache rescan (watch) with few changes stays on the main thread. Worker
  results are structured-cloned copies, and the graph is identical either way
  (`tests/parse-workers.test.ts`, and byte-identical normalized exports of
  `internet-nest`). From the TypeScript sources (`npm run dev`, tests) workers
  start only when asked for, since each one compiles the sources again.
- From the CLI, `scan --no-cache` of `internet-nest` goes from 2.3 s to 1.6 s
  wall time.

### Grammar upgrades

Scan time must not regress when grammars change. Before running
`npm run grammars:build` with new versions, record a baseline on the same
machine, then compare after the rebuild:

```bash
npm run bench:parser -- --json .concentrate/bench-before.json
# update versions in scripts/build-grammars.mjs, then:
npm run grammars:build
npm run bench:parser -- --baseline .concentrate/bench-before.json
```

The comparison lists the grammars that changed and exits with 1 when a
sample's parse or scan median is more than 1.15× the baseline and at least
20 ms slower (`--tolerance`, `--min-delta`), so the small samples' 1–2 ms
jitter does not count.

## Release report

`npm run bench:release` (Phase 8) builds, then measures the built CLI the way
a user runs it, on every sample:

- **Cold scan:** `concentrate scan --no-cache` in a child process, the median
  of 3 runs (`--runs`), with the process's peak RSS. `scripts/scan-probe.mjs`
  is preloaded with `--import` and records `process.resourceUsage().maxRSS`
  on exit, so no outside tool is needed.
- **Warm scan:** the same after a run that filled the parse cache.
- **Tool latency:** p50 / p95 of every MCP tool over 20 calls after a
  warm-up (`--tool-runs`), on the graph the scan wrote. Arguments come from
  the graph: the most-called function, its file, the first route and the
  first resolved import. `route_details` has no case on ky, which has no
  routes.

Each run writes `bench/results/<version>-<date>.json`; `--baseline` compares
against an earlier one like `bench:parser` does (scan times and memory at
1.15× and +20 ms / MB, tool p50s at +2 ms) and exits with 1 on a regression:

```bash
npm run bench:release -- --baseline bench/results/0.1.0-2026-10-29.json
```

Recorded 2026-10-29 for 0.1.0 on an Apple M4 (10 CPUs), Node v24.13.0
([`bench/results/0.1.0-2026-10-29.json`](../bench/results/0.1.0-2026-10-29.json)).
Wall times include Node startup, parsing, resolution and the store write.

| Sample | Nodes | Rels | Cold scan ms | Cold peak RSS MB | Warm scan ms | Warm peak RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 12879 | 14064 | 368 | 276 | 238 | 173 |
| fastify | 398 | 456 | 101 | 118 | 80 | 73 |
| nestjs-starter | 85 | 113 | 85 | 120 | 78 | 70 |
| ky | 7013 | 8581 | 368 | 210 | 180 | 135 |
| internet-node-express-firebase-mongodb | 515 | 642 | 114 | 137 | 82 | 74 |
| internet-node-express-realworld | 696 | 1203 | 124 | 123 | 91 | 78 |
| internet-nest | 52733 | 69503 | 1680 | 541 | 1278 | 625 |

- A cold scan of `internet-nest` (1,714 files) takes 1.7 s and peaks at
  541 MB; the small samples have a floor of about 0.1 s.
- The warm scan of `internet-nest` is 1.3× faster but peaks higher than the
  cold one (625 MB); the cause is not investigated yet.

Tool latency, p50 / p95 ms:

| Tool | express | fastify | nestjs-starter | ky | internet-node-express-firebase-mongodb | internet-node-express-realworld | internet-nest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graph_stats | 5.77 / 6.44 | 0.33 / 0.4 | 0.21 / 0.3 | 2.82 / 3.56 | 0.4 / 0.58 | 0.43 / 1.67 | 21.81 / 23.81 |
| find_definitions | 1.14 / 1.68 | 0.33 / 1.52 | 0.26 / 1.82 | 0.61 / 0.71 | 0.38 / 1.44 | 0.33 / 0.43 | 5.08 / 7.86 |
| find_callers | 3.37 / 7.07 | 0.42 / 0.49 | 0.26 / 0.28 | 5.52 / 9.47 | 0.49 / 0.56 | 0.58 / 2.03 | 25.4 / 30.57 |
| list_exports | 1.61 / 4.18 | 0.51 / 2.13 | 0.38 / 0.45 | 1.03 / 2.93 | 0.63 / 2.28 | 0.6 / 0.7 | 17.2 / 20.46 |
| trace_import_chain | 0.6 / 3.37 | 0.12 / 0.13 | 0.09 / 0.11 | 0.36 / 2.05 | 0.14 / 0.15 | 0.21 / 3.7 | 13.37 / 19.63 |
| list_routes | 0.47 / 0.56 | 0.09 / 0.11 | 0.08 / 0.09 | 0.08 / 0.1 | 0.12 / 0.13 | 0.22 / 0.26 | 1.6 / 2.79 |
| list_entrypoints | 0.11 / 0.14 | 0.08 / 0.09 | 0.07 / 0.1 | 0.08 / 0.09 | 0.08 / 0.1 | 0.09 / 0.1 | 0.44 / 0.48 |
| list_env_config | 0.35 / 2.15 | 0.23 / 0.27 | 0.21 / 0.23 | 0.25 / 0.29 | 0.26 / 0.3 | 0.27 / 0.35 | 2.34 / 4.21 |
| list_data_access | 0.34 / 0.41 | 0.24 / 0.35 | 0.21 / 1.46 | 0.24 / 0.29 | 0.28 / 0.33 | 0.81 / 1.85 | 1.78 / 3.32 |
| list_tables | 0.37 / 0.41 | 0.25 / 0.27 | 0.22 / 0.24 | 0.25 / 1.59 | 0.26 / 1.93 | 0.5 / 0.56 | 2.45 / 3.99 |
| impact_of | 13.45 / 21.74 | 0.74 / 2.59 | 0.48 / 0.51 | 7.44 / 13.44 | 0.77 / 0.89 | 1.16 / 3.16 | 54.89 / 63.38 |
| detect_changes | 22.67 / 25.38 | 21.88 / 23.97 | 22.38 / 23.3 | 22.12 / 22.82 | 21.88 / 23.94 | 22.15 / 22.8 | 48.42 / 52.59 |
| route_details | 13.63 / 22.3 | 0.86 / 0.99 | 0.64 / 0.88 | – | 0.88 / 2.73 | 1.23 / 3.81 | 63.26 / 85.11 |
| get_symbol_source | 0.88 / 0.97 | 0.39 / 2.34 | 0.38 / 0.45 | 0.37 / 0.45 | 0.34 / 0.4 | 0.35 / 0.4 | 2.73 / 4.96 |
| get_file_outline | 0.94 / 4.21 | 0.52 / 0.59 | 0.48 / 1.6 | 0.72 / 1.69 | 0.52 / 0.58 | 0.61 / 0.75 | 15.89 / 27.03 |
| search_symbols | 1.8 / 3.14 | 0.45 / 2.18 | 0.36 / 0.41 | 1.37 / 2.9 | 0.5 / 1.9 | 0.53 / 2.28 | 23.63 / 24.58 |
| find_references | 15.39 / 24.55 | 1.2 / 2.56 | 0.78 / 2.23 | 12.82 / 17.38 | 1.27 / 2.76 | 1.62 / 3.86 | 102.35 / 123 |
| find_import_cycles | 1.34 / 3.5 | 0.21 / 0.24 | 0.14 / 0.17 | 0.76 / 3.74 | 0.24 / 2 | 0.35 / 0.42 | 25.18 / 39.49 |
| find_unused_exports | 17.53 / 21.63 | 1.47 / 3.88 | 0.85 / 2.86 | 13.44 / 15.92 | 1.49 / 3.47 | 2.32 / 4.33 | 123.42 / 161.66 |
| architecture_overview | 2.44 / 4.78 | 0.57 / 0.69 | 0.45 / 0.59 | 1.62 / 4.26 | 0.62 / 2.36 | 0.95 / 2.96 | 46.4 / 65.03 |

- Every tool answers in under 25 ms on the standing samples. On
  `internet-nest` (52,733 nodes) the listing tools stay under 25 ms and the
  traversals (`impact_of`, `route_details`, `find_references`,
  `find_unused_exports`) take 50–125 ms.
- `detect_changes` runs `git`: about 22 ms on the small graphs, 48 ms on
  `internet-nest`.
