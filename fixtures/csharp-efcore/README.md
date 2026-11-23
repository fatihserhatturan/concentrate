# csharp-efcore (Phase 47 placeholder)

Wave 0 placeholder for track A (EF Core): only this README is here, so `tests/golden.test.ts` and
`tests/golden-queries.test.ts` skip the directory (a fixture directory holding nothing but README.md is pending). The owning
track replaces it with real sources (with a `.csproj`), then runs `npm run golden:update` to record
`tests/golden/fixtures/csharp-efcore.jsonl` and `tests/golden/queries/csharp-efcore.json`, and fills the `csharp-efcore` list of
`tests/golden/query-cases.json`. Delete this README when the sources exist.
