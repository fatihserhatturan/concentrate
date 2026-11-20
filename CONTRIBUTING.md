# Contributing

Thanks for your interest in Concentrate. Issues and pull requests are welcome.
Before you start:

- [docs/known-limitations.md](docs/known-limitations.md) lists what the graph
  misses today.
- The [open issues](https://github.com/fatihserhatturan/concentrate/issues)
  turn those gaps into concrete tasks, and each one names the number it should
  move.
- [docs/architecture.md](docs/architecture.md) shows where things live.

## Setup

Node.js 22 or newer.

```bash
npm install
npm run samples:fetch     # fetch pinned sample repos into .concentrate/samples
```

## Commands

```bash
npm test                  # unit tests
npm run typecheck         # TypeScript check
npm run build             # compile to dist/
npm run verify:rc         # typecheck + tests + build + standing smoke
npm run test:samples      # golden graph + query tests on the samples (required, not skipped)
npm run golden:update     # rewrite golden files after an intended behavior change
npm run grammars:build    # rebuild vendor/grammars/*.wasm from the pinned grammar versions
npm run bench:accuracy    # precision / recall against hand-written labels
npm run bench:release     # scan time, memory and tool latency of the built CLI
```

## Ground rules

- **One runtime dependency.** Only `web-tree-sitter` ships. Use stable
  `node:` APIs instead of adding packages; the dependency guardrail test
  fails otherwise.
- **Precision first.** A change that finds more but also reports wrong facts
  needs a strong reason. Run `npm run bench:accuracy -- --details` before and
  after, and see [docs/accuracy.md](docs/accuracy.md) for how labels are
  written.
- **Golden tests** (`tests/golden*.test.ts`) pin graph output and MCP query
  results. Regenerate them only for an intended change and review the diff;
  see [tests/golden/README.md](tests/golden/README.md).
- **Grammars** are built from pinned npm versions with the pinned
  `tree-sitter-cli` and committed with a sha256 manifest
  (`vendor/grammars/manifest.json`, checked by `tests/grammars.test.ts`). To
  upgrade one, change its version in `scripts/build-grammars.mjs`, run
  `npm run grammars:build`, and review the golden diffs.
- **New languages** plug in through the integration registry, not by editing
  core. [docs/adding-a-language.md](docs/adding-a-language.md) lists every
  step, from the grammar to the UI highlight map.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
