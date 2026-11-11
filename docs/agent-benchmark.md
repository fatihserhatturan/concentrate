# Agent benchmark

Does an agent answer code questions better or more cheaply when it has
Concentrate's MCP tools? The benchmark asks Claude Code the same questions
twice per run, on the pinned sample repositories:

- **baseline:** `claude -p` with its file tools only: `Read`, `Grep`, `Glob`
  and `ls`.
- **concentrate:** the same tools plus the `concentrate` MCP server
  (`concentrate mcp`) on a graph of the sample.

Both modes run with `--strict-mcp-config`, so the user's own MCP servers are
left out, and with editing, web and sub-agent tools disallowed. The only
difference is the MCP server.

```bash
npm run samples:fetch
npm run bench:agent -- --dry-run          # print the commands, call nothing
npm run bench:agent -- --runs 3           # every question, 3 runs per mode
npm run bench:agent -- --question rw-env --runs 1 --model sonnet
npm run bench:agent -- --rescore bench/results/agent-runs3-2026-10-29.json --details
```

It needs the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code),
signed in. `--claude <path>` or `CLAUDE_BIN` names it; otherwise `claude` on
`PATH` is used and, when it is not there, the newest CLI the Claude desktop
app ships (`~/Library/Application Support/Claude/claude-code/<version>/…/claude`
on macOS). When none is found, the error lists where it looked. Runs use that account: a
subscription's usage limits, or API billing when `ANTHROPIC_API_KEY` is set.
13 questions × 2 modes × 3 runs is 78 sessions; `--runs 1` is 26.

## Questions

[`bench/agent/questions.json`](../bench/agent/questions.json) holds 13
questions over five samples, in six categories (the harder set is under
[Harder questions](#harder-questions)):

| Category | Questions | Example |
| --- | ---: | --- |
| callers | 4 | Which functions call `generateToken`? |
| data | 3 | In sample/06-mongoose, which HTTP routes modify the cats collection? |
| routes | 2 | List every HTTP route in the fastify-postgres example. |
| env | 2 | Which environment variables does this app read? |
| impact | 1 | If `profileMapper` changes, which HTTP routes are affected? |
| cycles | 1 | Is there an import cycle inside packages/core/repl? |

The expected answers were written by reading the sample source, not taken
from Concentrate's output. Some questions fall on gaps the
[accuracy report](accuracy.md) found: `generateToken` is called through a
default import that the graph does not resolve, and the fastify-postgres
routes are declared inside a function. Those questions show what an agent
does when the graph is incomplete.

## Scoring

Scoring is deterministic; no model judges the answers. An answer is correct
when it contains every `mustInclude` string and at least one string of each
`anyOf` group, compared case-insensitively with Markdown code marks, quotes
and line breaks ignored. A run that ends in an error (for example the
`--max-turns` limit, 30 by default) is incorrect.

Per question and mode the report gives the number of correct runs and the
medians of:

- **input tokens:** everything the model read, cache writes and reads
  included;
- **output tokens;**
- **tool calls:** the `tool_use` blocks in the transcript, MCP calls included;
- **turns, duration and cost,** as `claude -p --output-format stream-json`
  reports them.

Each median comes with the lowest and highest run, `median (min–max)`. The
report then gives:

- **per category,** the same figures over all runs of the category and its
  total cost, so a gain in one category is not read as an overall one;
- **all runs,** per mode, with the total cost;
- **MCP use** in concentrate mode: how many runs called a `concentrate` tool,
  the `ToolSearch` calls that load the tool schemas, and the calls per tool.

`--details` adds two tables: each wrong run with the keys its answer missed
(to tell a wrong answer from a key that rejects a right one), and every MCP
call of concentrate mode with its input and the start of its result (to find
empty or wrong graph answers).

Results go to `bench/results/agent-<date>.json` with every run's answer,
tool counts, missed keys and MCP calls (input and result, the result cut at
2,000 characters), and the per-mode, per-category and total summaries. `--rescore`
rebuilds the summaries of an older results file without new runs; the files
in `bench/results/` have been rescored this way.


## Results

Recorded 2026-10-29 with Claude Code 2.1.309, `--model sonnet`, three runs per
question and mode (`--runs 3 --max-turns 15`)
([`bench/results/agent-runs3-2026-10-29.json`](../bench/results/agent-runs3-2026-10-29.json)).
The graph includes the accuracy work through #49. Medians; `base → concentrate`:

| Question | Category | Correct (base / conc.) | Input tokens | Output tokens | Tool calls | Cost USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| rw-token-callers | callers | 3/3 / 3/3 | 95.3k → 97.2k | 0.5k → 0.3k | 2 → 2 | 0.0491 → 0.05 |
| rw-profile-mapper-impact | impact | 3/3 / 3/3 | 132.5k → 100.2k | 1.1k → 0.5k | 4 → 2 | 0.0697 → 0.0606 |
| rw-delete-comment-tables | data | 3/3 / 3/3 | 163.8k → 98.8k | 1.5k → 0.5k | 6 → 2 | 0.0777 → 0.0568 |
| rw-env | env | 3/3 / 3/3 | 96.0k → 98.4k | 0.8k → 0.8k | 3 → 4 | 0.0545 → 0.0585 |
| rw-http-exception | callers | 3/3 / 3/3 | 94.9k → 65.0k | 0.4k → 0.4k | 2 → 1 | 0.0472 → 0.0487 |
| fastify-postgres-routes | routes | 2/3 / 3/3 | 97.6k → 132.6k | 0.7k → 0.7k | 4 → 5 | 0.0574 → 0.0633 |
| fastify-env | env | 3/3 / 3/3 | 63.2k → 97.4k | 0.4k → 0.5k | 2 → 3 | 0.0442 → 0.0519 |
| express-user-routes | routes | 3/3 / 3/3 | 64.0k → 65.1k | 0.4k → 0.4k | 1 → 1 | 0.0467 → 0.0481 |
| express-trystat | callers | 3/3 / 3/3 | 95.3k → 97.0k | 0.4k → 0.5k | 2 → 2 | 0.0494 → 0.0517 |
| ky-validate-and-merge | callers | 3/3 / 3/3 | 95.9k → 97.6k | 0.5k → 0.5k | 2 → 2 | 0.0517 → 0.0541 |
| nest-typeorm-user-writes | data | 3/3 / 3/3 | 96.1k → 97.7k | 0.6k → 0.6k | 3 → 3 | 0.0539 → 0.0558 |
| nest-mongoose-cat-writes | data | 3/3 / 3/3 | 96.0k → 97.5k | 0.6k → 0.8k | 2 → 3 | 0.0541 → 0.0565 |
| nest-repl-cycle | cycles | 3/3 / 3/3 | 131.3k → 97.7k | 1.3k → 0.8k | 4 → 2 | 0.068 → 0.0575 |

| | Baseline | Concentrate |
| --- | ---: | ---: |
| Correct | 38/39 | 39/39 |
| Median input tokens | 96.0k | 97.7k (+2%) |
| Median tool calls | 2 | 2 |
| Total cost (CLI estimate) | $2.30 | $2.15 |

What this run shows:

- **Overall, about the same.** The questions are narrow and the samples
  small, so one or two greps answer most of them, and the medians over all
  runs barely move.
- **The agent used the MCP tools in 21 of 39 runs** (in every run of seven
  questions and in none of the other six; `list_env_config`,
  `find_callers`, `impact_of`, `route_details`, `list_routes`,
  `find_import_cycles`). Claude Code loads MCP tools on demand, so each of
  those runs paid for a `ToolSearch` call first.
- **Where it helped:** the questions that follow the graph. The
  `profileMapper` impact, the tables behind a route and the REPL import
  cycle took 2 tool calls instead of 4–6 and about 25–40% fewer input tokens.
  In the one-run measurement before the accuracy work, the same impact and
  route-tables questions cost *more* with Concentrate, because the graph's
  answers were checked with grep.
- **Where it cost more:** `fastify-env` and `fastify-postgres-routes`, where
  the MCP call came on top of a grep. The baseline missed the `PATCH` route
  in one of three `fastify-postgres-routes` runs; Concentrate found all of
  them each time.

An earlier one-run measurement (Claude Code 2.1.308,
[`bench/results/agent-2026-10-29.json`](../bench/results/agent-2026-10-29.json))
had both modes at 13/13. Its first scoring missed the two
`nest-mongoose-cat-writes` answers, which put the routes in a Markdown table
(`| POST | /cats |`). The scorer now reads table bars as spaces, and
`npm run bench:agent -- --rescore <file>` re-scored the saved answers
without new runs.

### Harder questions

[`bench/agent/questions-hard.json`](../bench/agent/questions-hard.json) has six
questions over all of `internet-nest` (1,714 files) that need many files or
the import graph: the files in two runtime import cycles, the direct
importers of `instance-wrapper.ts`, and the models, DELETE routes and env
variables across `sample/`. Expected answers were computed from the source
(import statements, decorators, `process.env` reads).

```bash
npm run bench:agent -- --questions bench/agent/questions-hard.json --runs 3 --model sonnet --max-turns 25
```

Recorded 2026-10-29, same CLI and model, three runs each, `--max-turns 25`
([`bench/results/agent-hard-runs3-2026-10-29.json`](../bench/results/agent-hard-runs3-2026-10-29.json)):

| Question | Category | Correct (base / conc.) | Input tokens | Output tokens | Tool calls | Cost USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| nest-injector-cycles | cycles | 0/3 / 3/3 | 453.7k → 97.6k | 8.6k → 0.6k | 14 → 2 | 0.2353 → 0.0543 |
| nest-instance-wrapper-importers | impact | 3/3 / 3/3 | 65.7k → 66.9k | 1.9k → 1.7k | 1 → 1 | 0.0724 → 0.0693 |
| nest-microservices-client-cycle | cycles | 0/3 / 3/3 | 211.2k → 97.5k | 2.4k → 0.6k | 5 → 2 | 0.1019 → 0.0544 |
| nest-sample-models | data | 3/3 / 3/3 | 98.5k → 101.3k | 1.5k → 1.0k | 3 → 4 | 0.0678 → 0.0709 |
| nest-sample-delete-routes | routes | 3/3 / 3/3 | 98.0k → 100.2k | 0.9k → 1.0k | 3 → 3 | 0.06 → 0.0629 |
| nest-sample-env | env | 3/3 / 3/3 | 128.1k → 97.3k | 0.9k → 0.8k | 3 → 2 | 0.0591 → 0.0554 |

| | Baseline | Concentrate |
| --- | ---: | ---: |
| Correct | 12/18 | 18/18 |
| Median input tokens | 128.0k | 97.6k (−24%) |
| Median tool calls | 3 | 2 (−33%) |
| Median turns | 4 | 3 (−25%) |
| Median wall time | 19.3 s | 14.5 s (−25%) |
| Total cost (CLI estimate) | $1.85 | $1.11 |

- **Import cycles are where the graph pays off.** Grep cannot see a cycle.
  The baseline traced imports by hand and missed files of both cycles in
  all six runs; on the injector cycle it took 14–22 tool calls and read 4.6×
  the tokens. With `find_import_cycles` the agent answered both questions
  correctly in every run, in two calls.
- **The injector question is fixed.** In the one-run measurement before it,
  `find_import_cycles` listed only 30 of the cycle's 52 members and the
  agent called its answer incomplete. The tool has since gained a `path`
  filter (`{ path: "packages/core/injector" }` lists exactly the 14 injector
  files), and the question went from 0/1 to 3/3.
- **Repository-wide listings cost about the same.** The env question's
  median took two calls instead of three at about 25% fewer tokens, but no
  run of it called a `concentrate` tool, so that gap is run-to-run variance,
  not the graph. For models (`list_tables` in all three runs) and DELETE
  routes (grep in both modes) costs were within a few percent.

Per category and MCP use, from the rescored results file:

| Category | Runs | Correct (base / conc.) | Input tokens, median (min–max) | Tool calls | Total cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| cycles | 6 | 0/6 / 6/6 | 320.4k (208.9k–521.7k) → 97.5k (97.5k–97.6k) (−70%) | 10.5 (5–22) → 2 (2–2) | $1.05 → $0.33 |
| impact | 3 | 3/3 / 3/3 | 65.7k (64.3k–100.1k) → 66.9k (66.3k–100.4k) (+2%) | 1 (1–2) → 1 (1–2) | $0.21 → $0.21 |
| data | 3 | 3/3 / 3/3 | 98.5k (98.3k–133.1k) → 101.3k (99.8k–137.5k) (+3%) | 3 (3–5) → 4 (3–5) | $0.22 → $0.21 |
| routes | 3 | 3/3 / 3/3 | 98.0k (97.6k–102.4k) → 100.2k (100.1k–101.7k) (+2%) | 3 (3–3) → 3 (3–3) | $0.19 → $0.19 |
| env | 3 | 3/3 / 3/3 | 128.1k (128.0k–128.1k) → 97.3k (97.3k–130.6k) (−24%) | 3 (3–3) → 2 (2–3) | $0.18 → $0.17 |

The agent called a `concentrate` tool in 9 of 18 runs: `find_import_cycles`
in all six cycle runs and `list_tables` in the three model runs. The whole
gain of the hard set comes from the cycles category; outside it the two
modes are within a few percent.

The one-run measurement of this set
([`bench/results/agent-hard-2026-10-29.json`](../bench/results/agent-hard-2026-10-29.json))
had 4/6 → 5/6 correct, −23% median input tokens and −43% median tool calls.

### v2 questions (#73)

[`bench/agent/questions-v2.json`](../bench/agent/questions-v2.json) has nine
questions for the parts of the graph the earlier sets do not test:

| Category | Questions | What it needs |
| --- | ---: | --- |
| calls | 2 | callers of `normalizePath` in `internet-nest` packages, where grep also finds four unrelated methods of that name; callers of the static `UuidFactory.get` |
| impact | 1 | the route a service method reaches two calls up (`UsersService.findOne` → `AuthService.signIn` → `POST /auth/login`) |
| diff | 1 | the routes an uncommitted change to two services affects (`detect_changes`) |
| unused | 1 | the exports of `packages/common/utils` nothing imports (`find_unused_exports`) |
| gap | 4 | answers the graph does not have: express's `app.listen` (mixed into `app` at runtime), the routes `examples/route-map` registers in a loop, a method declared as a class field (`setSecurityData`), and requests whose URL a `switch` picks |

The gap questions check that the agent does not stop at an empty or partial
graph answer; on each of them the matching tool returns nothing.

Two question fields support them. `patch` (relative to the questions file)
is applied to the sample with `git apply` before each run and reverted after
it, so the graph, scanned before, is the base of the diff. `extraTools` adds
tools to both modes; the diff question allows `Bash(git diff:*)` and
`Bash(git status:*)`, so the baseline can see the change too.

```bash
npm run bench:agent -- --questions bench/agent/questions-v2.json --runs 3 --model sonnet --max-turns 25
```

Recorded 2026-11-02 with sonnet and haiku, same CLI, three runs each,
`--max-turns 25` ([`agent-v2-sonnet-runs3-2026-11-02.json`](../bench/results/agent-v2-sonnet-runs3-2026-11-02.json),
[`agent-v2-haiku-runs3-2026-11-02.json`](../bench/results/agent-v2-haiku-runs3-2026-11-02.json)).
Per category, median input tokens (min–max) over all runs of the category:

| Category | Runs | sonnet: correct | sonnet: input tokens | haiku: correct | haiku: input tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| calls | 6 | 6/6 / 6/6 | 63.6k → 64.8k (+2%) | 6/6 / 6/6 | 66.2k → 101.5k (+53%) |
| impact | 3 | 3/3 / 3/3 | 97.2k → 99.7k (+3%) | 3/3 / 3/3 | 136.1k → 205.0k (+51%) |
| diff | 3 | 3/3 / 3/3 | 97.2k → 99.5k (+2%) | 3/3 / 3/3 | 134.8k → 138.8k (+3%) |
| unused | 3 | 3/3 / 3/3 | 468.2k (427.4k–689.3k) → 132.5k (132.5k–244.4k) (−72%) | 3/3 / 3/3 | 847.9k (653.6k–862.7k) → 175.0k (136.5k–260.0k) (−79%) |
| gap | 12 | 12/12 / 12/12 | 82.1k → 100.0k (+22%) | 12/12 / 12/12 | 133.7k → 136.8k (+2%) |

| | sonnet: baseline | sonnet: Concentrate | haiku: baseline | haiku: Concentrate |
| --- | ---: | ---: | ---: | ---: |
| Correct | 27/27 | 27/27 | 27/27 | 27/27 |
| Median input tokens | 97.2k | 99.5k (+2%) | 134.8k | 137.6k (+2%) |
| Median tool calls | 2 | 2 | 4 | 4 |
| Median wall time | 10.9 s | 8.7 s (−20%) | 9.5 s | 12.1 s (+27%) |
| Total cost (CLI estimate) | $1.97 | $1.59 | $0.19 | $0.12 |
| Runs with an MCP call | – | 9/27 | – | 7/27 |

- **Unused exports are the one clear gain.** Grep cannot prove that nothing
  imports a name, so the baseline read the whole package: 26 (sonnet) and
  36 (haiku) median tool calls against 4 and 6 with `find_unused_exports`,
  at a quarter of the cost.
- **The other categories cost the same or more.** Both models answered the
  caller questions with grep (no MCP call in any run). Haiku answered the
  impact question with `impact_of`, `find_definitions` and `list_routes` in
  seven calls instead of three, at 51% more tokens; sonnet took two.
- **The agent does not stop at a graph gap.** All 24 gap runs were correct
  in both modes. Only the full-stack request question called a tool
  (`api_consumers`, `list_routes`); with the empty answer the agent read the
  source, which cost sonnet 72% more tokens on that question.
- One key was widened after the runs: two correct answers to the unused
  question called `Constructor` "a type" in words the first `anyOf` did not
  match. All four result files were rescored with `--rescore`.

### Hard questions on two models (2026-11-02)

The hard set was rerun with the same settings on sonnet and haiku
([`agent-hard-sonnet-runs3-2026-11-02.json`](../bench/results/agent-hard-sonnet-runs3-2026-11-02.json),
[`agent-hard-haiku-runs3-2026-11-02.json`](../bench/results/agent-hard-haiku-runs3-2026-11-02.json)):

| Category | Runs | sonnet: correct | sonnet: input tokens | haiku: correct | haiku: input tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| cycles | 6 | 2/6 / 6/6 | 419.9k → 97.8k (−77%) | 1/6 / 6/6 | 664.2k → 100.6k (−85%) |
| impact | 3 | 3/3 / 3/3 | 64.3k → 65.6k (+2%) | 3/3 / 3/3 | 67.4k → 68.9k (+2%) |
| data | 3 | 3/3 / 3/3 | 98.2k → 137.6k (+40%) | 3/3 / 3/3 | 267.4k → 306.9k (+15%) |
| routes | 3 | 3/3 / 3/3 | 99.5k → 101.4k (+2%) | 3/3 / 3/3 | 181.7k → 141.9k (−22%) |
| env | 3 | 3/3 / 3/3 | 128.1k → 97.6k (−24%) | 3/3 / 3/3 | 97.9k → 135.0k (+38%) |

| | sonnet: baseline | sonnet: Concentrate | haiku: baseline | haiku: Concentrate |
| --- | ---: | ---: | ---: | ---: |
| Correct | 14/18 | 18/18 | 13/18 | 18/18 |
| Median input tokens | 128.0k | 97.9k (−24%) | 216.3k | 103.8k (−52%) |
| Median tool calls | 3 | 2 (−33%) | 8.5 | 2 (−76%) |
| Median wall time | 20.4 s | 13.5 s (−34%) | 23.5 s | 18.7 s (−20%) |
| Total cost (CLI estimate) | $2.22 | $1.12 | $0.21 | $0.09 |
| Runs with an MCP call | – | 9/18 | – | 6/18 |

- **The cycle result holds on both models.** `find_import_cycles` answered
  both cycle questions in two calls in all twelve runs; without it sonnet
  got 2 of 6 and haiku 1 of 6, at 4–7× the tokens.
- **Haiku gains more overall** (−52% median tokens, −76% tool calls),
  because its baseline searches longer on every question.
- **Outside cycles the signs flip between models.** The env question is
  −24% on sonnet and +38% on haiku with no MCP call on either, and the data
  question costs more on both (sonnet called `list_tables`, then read the
  entities anyway). These differences are run-to-run variance and extra
  verification, not the graph.

### Conclusion of v2

Across 15 questions, two models and 180 runs, the graph changes the result
where grep cannot see the answer: import cycles (correct 3/12 → 12/12) and
unused exports (−72% to −79% tokens). Everywhere else, including callers,
impact and diffs, an agent that can grep reaches the same answer at about
the same cost, and sometimes spends more checking the graph's answer.

### Frontend and full-stack questions

[`bench/agent/questions-frontend.json`](../bench/agent/questions-frontend.json)
has six questions over the RealWorld frontends, two per category:

- **frontend-api:** which component sends the favorite requests and which
  backend service functions those routes call; which route, service function
  and model a submitted comment reaches (`internet-realworld-fullstack`);
- **frontend-impact:** which Next.js pages render `ArticlePreview` through
  other components; which Angular routes display `ArticleListComponent`,
  lazy-loaded profile routes included;
- **store:** which Vue pages use the Pinia user store directly or through a
  component at any depth; which components write it through `updateUser`.

Expected answers were written from the source (JSX and template elements,
router records, HTTP calls, store hook calls). The benchmark now passes a
sample's `apiOrigins` to the scan, so the full-stack graph links the
frontend calls to the backend routes as `bench:accuracy` does.

```bash
npm run bench:agent -- --questions bench/agent/questions-frontend.json --runs 3 --model sonnet --max-turns 25
```

Recorded 2026-11-02 with Claude Code 2.1.309, `--model sonnet`, three runs
each, `--max-turns 25`
([`bench/results/agent-frontend-runs3-2026-11-02.json`](../bench/results/agent-frontend-runs3-2026-11-02.json)):

| Question | Category | Correct (base / conc.) | Input tokens | Output tokens | Tool calls | Cost USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| fs-favorite-consumers | frontend-api | 3/3 / 3/3 | 100.0k → 143.4k | 1.0k → 1.0k | 4 → 5 | 0.0712 → 0.0851 |
| fs-comment-submit | frontend-api | 3/3 / 3/3 | 101.1k → 140.6k | 1.2k → 1.1k | 6 → 5 | 0.0696 → 0.0753 |
| fs-article-preview-pages | frontend-impact | 3/3 / 3/3 | 131.4k → 101.7k | 1.0k → 0.6k | 3 → 2 | 0.0599 → 0.0584 |
| ng-article-list-routes | frontend-impact | 3/3 / 3/3 | 99.0k → 101.9k | 1.1k → 0.7k | 5 → 3 | 0.071 → 0.0644 |
| vue-user-store-pages | store | 3/3 / 3/3 | 73.6k → 108.0k | 1.3k → 1.6k | 2 → 4 | 0.0727 → 0.0799 |
| vue-user-store-writers | store | 3/3 / 3/3 | 66.4k → 67.8k | 0.5k → 0.5k | 1 → 1 | 0.0454 → 0.0482 |

Per category (medians over six runs; cost is the sum):

| Category | Correct (base / conc.) | Input tokens | Tool calls | Cost USD |
| --- | ---: | ---: | ---: | ---: |
| frontend-api | 6/6 / 6/6 | 101.0k → 142.0k | 5 → 5 | 0.50 → 0.48 |
| frontend-impact | 6/6 / 6/6 | 131.4k → 101.9k | 3.5 → 3 | 0.39 → 0.38 |
| store | 6/6 / 6/6 | 67.9k → 87.3k | 1.5 → 2 | 0.38 → 0.39 |

| | Baseline | Concentrate |
| --- | ---: | ---: |
| Correct | 18/18 | 18/18 |
| Median input tokens | 100.4k | 107.4k (+7%) |
| Median tool calls | 3.5 | 3.5 |
| Median turns | 4.5 | 4.5 |
| Median wall time | 14.2 s | 17.2 s (+20%) |
| Total cost (CLI estimate) | $1.27 | $1.25 |

- **No accuracy difference.** The RealWorld frontends are small and name
  things plainly, so grep answered every question in both
  modes.
- **Impact questions got cheaper.** `impact_of` returned the pages and routes
  in one call: the Next.js page question used 23% fewer input tokens, and
  the Angular route question, which needs the lazy `loadChildren` profile
  routes, took 3 tool calls instead of 5.
- **API questions cost more input.** The agent used `api_consumers` and
  `route_details` in five of six runs; their results, plus the `ToolSearch`
  that loads them, are larger than the two or three grep hits the baseline
  needed.
- **The store tools went unused.** In all six store runs the agent grepped
  for `useUserStore` / `updateUser` instead of calling `list_stores` or
  `impact_of`; with a single store and a distinctive hook name, grep is the
  shorter path. A repository with several stores, or slices reached through
  selectors, would be the fairer test.

### Go questions (Phase 21)

[`bench/agent/questions-go.json`](../bench/agent/questions-go.json) has eight
questions over the Go RealWorld backends and the Next.js frontend scanned
with the gin backend:

- **routes:** the handler and middleware of gin's
  `POST /api/profiles/:username/follow` (`AuthMiddleware(true)`); echo's
  `GET /api/articles/feed` handler, the concrete store method it reaches
  through the `article.Store` interface, and its JWT middleware;
- **callers:** the production callers of gin's `FindOneArticle`;
- **impact:** the routes and handlers a change to gin's `FindOneUser` or
  echo's `UserStore.GetByUsername` reaches;
- **data:** the functions that read and write gin's `FavoriteModel`;
- **env:** the env variables gin's production code reads, and where;
- **frontend-api:** the page and API module that send the follow requests
  and the gin handlers that receive them (`internet-realworld-go-fullstack`).

Expected answers were written from the source (route registrations in
`main` and the `Register` functions, call sites, gorm queries,
`os.Getenv`, the frontend's API calls).

```bash
npm run bench:agent -- --questions bench/agent/questions-go.json --runs 3 --model sonnet --max-turns 25
npm run bench:agent -- --questions bench/agent/questions-go.json --runs 3 --model haiku --max-turns 25
```

Recorded 2026-11-04 with Claude Code 2.1.317, three runs each,
`--max-turns 25`
([`agent-go-sonnet-runs3-2026-11-04.json`](../bench/results/agent-go-sonnet-runs3-2026-11-04.json),
[`agent-go-haiku-runs3-2026-11-04.json`](../bench/results/agent-go-haiku-runs3-2026-11-04.json)).
Per category, median input tokens (baseline → concentrate) and the runs in
which the agent called a Concentrate tool:

| Category | Runs | sonnet: correct | sonnet: input tokens | sonnet: MCP runs | haiku: correct | haiku: input tokens | haiku: MCP runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| routes | 6 | 6/6 / 6/6 | 105.0k → 100.0k (−5%) | 0/6 | 6/6 / 6/6 | 166.7k → 169.2k (+2%) | 0/6 |
| callers | 3 | 3/3 / 3/3 | 102.2k → 105.1k (+3%) | 0/3 | 3/3 / 3/3 | 105.4k → 108.1k (+3%) | 1/3 |
| impact | 6 | 6/6 / 6/6 | 122.0k → 109.4k (−10%) | 4/6 | 6/6 / 6/6 | 129.1k → 110.7k (−14%) | 4/6 |
| data | 3 | 3/3 / 3/3 | 143.1k → 107.6k (−25%) | 0/3 | 3/3 / 3/3 | 121.2k → 167.7k (+38%) | 3/3 |
| env | 3 | 3/3 / 3/3 | 102.4k → 104.5k (+2%) | 0/3 | 3/3 / 3/3 | 107.1k → 149.7k (+40%) | 1/3 |
| frontend-api | 3 | 3/3 / 3/3 | 137.7k → 111.5k (−19%) | 3/3 | 3/3 / 3/3 | 205.8k → 160.6k (−22%) | 3/3 |

| | sonnet: baseline | sonnet: concentrate | haiku: baseline | haiku: concentrate |
| --- | ---: | ---: | ---: | ---: |
| Correct | 24/24 | 24/24 | 24/24 | 24/24 |
| Median input tokens | 108.2k | 106.4k (−2%) | 130.6k | 154.3k (+18%) |
| Median tool calls | 3 | 3 | 4 | 5 |
| Median wall time | 16.2 s | 16.3 s | 15.0 s | 16.0 s |
| Total cost (CLI estimate) | $1.87 | $1.58 | $0.13 | $0.14 |

- **No accuracy difference.** Every one of the 96 runs (8 questions × 2
  modes × 3 runs × 2 models) was correct. The two Go backends are small (21 and 24 files) and name handlers,
  stores and models plainly, so grep finds every answer.
- **Concentrate helped where an answer spans the stack.** The full-stack
  follow question (`api_consumers` in every run) used 19% (sonnet) and 22%
  (haiku) fewer input tokens, and the impact questions 10% and 14% fewer
  (`impact_of`, `find_callers`).
- **Differences without an MCP call are noise.** Sonnet never called a
  Concentrate tool on the route, callers, data and env questions; its −25%
  on the data question and the cheaper gin route runs come from how many
  files it chose to read, not from the graph.
- **Listings cost haiku more.** Haiku called `list_data_access` in all
  three data runs: the result lists the handlers each access is reached
  through as well as the functions that run the query, so it is longer than
  the grep hits (+38% input tokens). The rows of a reached-through function
  show that function's file with the query's line (`articles/routers.go:71`
  for a query at `articles/models.go:71`), which the agent had to check
  against the source.

### Larger Go repositories (#187)

The Phase 21 questions could not separate the modes: the Go backends were
small enough for grep. [`bench/agent/questions-go-large.json`](../bench/agent/questions-go-large.json)
asks eight questions over two larger repositories, where an answer crosses
packages, interfaces or services:

- **`internet-go-kratos-beer-shop`** (go-kratos/beer-shop, 283 Go files,
  nine kratos services wired with google/wire, ent, gRPC between services):
  - **di:** which gRPC clients of the gateway's provider set the generated
    injector builds and which it never uses (order, payment); which repositories
    and use cases the user service's injector wires into `NewUserService`;
  - **callers:** registration from the gateway's `ShopInterface.Register`
    over gRPC into the user service, down to the ent insert in
    `app/user/service/internal/data/user.go`;
  - **impact:** what a change to catalog's `beerRepo.Count` reaches
    (`BeerUseCase.ListNext`, `CatalogService.ListBeerNextToken`).
- **`internet-go-remark42`** (umputun/remark42 backend, 158 Go files outside
  `vendor/`):
  - **dispatch:** the production implementations of `engine.Interface` and
    `admin.Store`; the callers of the engine's `Flag` and the
    implementations each call reaches (`BoltDB`, `RPC`); the image stores
    `image.Service.SaveWithID` can write through and its callers;
  - **impact:** the callers of `DataStore.IsBlocked`, directly and through
    the REST handlers' store interfaces.

Expected answers were written from the source (`wire_gen.go`, interface
declarations and their implementations, call sites). When these runs were
made, the graph did not read remark42's routes (`go-pkgz/routegroup`) or
its env options (`go-flags` `env-namespace`), both read since #196, so no
route or env question is asked there.

```bash
npm run bench:agent -- --questions bench/agent/questions-go-large.json --runs 3 --model sonnet
npm run bench:agent -- --questions bench/agent/questions-go-large.json --runs 3 --model haiku
```

Recorded 2026-11-05 with Claude Code 2.1.317, three runs each,
`--max-turns 30`
([`agent-go-large-sonnet-runs3-2026-11-05.json`](../bench/results/agent-go-large-sonnet-runs3-2026-11-05.json),
[`agent-go-large-haiku-runs3-2026-11-05.json`](../bench/results/agent-go-large-haiku-runs3-2026-11-05.json)).
Sonnet's two last remark42 questions were run again after the first runs
stopped at the account's usage limit; their results replace the failed
runs in the file. Per category, median input tokens (baseline →
concentrate) and the runs in which the agent called a Concentrate tool:

| Category | Runs | sonnet: correct | sonnet: input tokens | sonnet: MCP runs | haiku: correct | haiku: input tokens | haiku: MCP runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| di | 6 | 6/6 / 6/6 | 96.9k → 99.6k (+3%) | 0/6 | 6/6 / 6/6 | 139.4k → 125.7k (−10%) | 0/6 |
| callers | 3 | 3/3 / 3/3 | 175.3k → 175.7k (+0%) | 0/3 | 3/3 / 3/3 | 261.9k → 236.4k (−10%) | 1/3 |
| impact | 6 | 6/6 / 6/6 | 166.4k → 110.6k (−34%) | 5/6 | 6/6 / 6/6 | 254.6k → 229.1k (−10%) | 5/6 |
| dispatch | 9 | 9/9 / 9/9 | 229.5k → 166.1k (−28%) | 0/9 | 9/9 / 9/9 | 360.4k → 418.3k (+16%) | 1/9 |

| | sonnet: baseline | sonnet: concentrate | haiku: baseline | haiku: concentrate |
| --- | ---: | ---: | ---: | ---: |
| Correct | 24/24 | 24/24 | 24/24 | 24/24 |
| Median input tokens | 170.9k | 157.9k (−8%) | 258.6k | 243.0k (−6%) |
| Median tool calls | 6 | 6 | 8 | 6 |
| Median wall time | 19.3 s | 20.4 s | 23.5 s | 20.9 s |
| Total cost (CLI estimate) | $2.45 | $2.10 | $0.23 | $0.21 |

- **Still no accuracy difference.** All 96 runs were correct. With 158–283
  files and descriptive names (`NewOrderServiceClient`, `BoltDB`), grep and a
  few reads still find every answer.
- **The graph helped where the agent asked it.** The impact questions, the
  only ones where the agent called Concentrate in most runs (`impact_of`,
  `find_callers`), cost sonnet 34% fewer input tokens.
- **The dispatch questions went unasked.** Sonnet never called a Concentrate
  tool on the four interface questions, although the graph resolves
  `s.Engine.Flag(…)` to `BoltDB.Flag` and `RPC.Flag` and holds `IMPLEMENTS`
  for every store. No tool returns an interface's implementations, and
  `find_callers` does not say that interface calls resolve to them; sonnet's
  −28% there comes from how many files it read, not from the graph.
- **The di questions are answered from `wire_gen.go`.** The generated
  injector lists every constructor call in order, so one read answers both
  questions; the graph's `INJECTS` adds nothing an agent needs.
- **The cross-service question is out of the graph's reach.** No edge links
  the gateway's `userv1.UserClient.Save` call to `UserService.Save` in the
  user service, so both modes read both sides.

## Non-code files (Phase 25)

[`bench/agent/questions-non-code.json`](../bench/agent/questions-non-code.json)
has ten questions on files that are not source: Makefile and CI runs, workflow
env, SQL migration tables, `.proto` rpcs and the Go methods that implement them,
and CSS class use (`internet-go-simplebank`, `internet-go-kratos-beer-shop`,
`internet-remark42-frontend`). Expected answers were written from the sample
files. **Not run yet**: a run costs money, so it waits for approval. Estimate
from the Go runs above (48 sonnet runs cost $3.45, 48 haiku runs $0.27, so
about $0.07 and $0.006 a run): ten questions, two modes, three runs is 60
runs per model, about $4.3 for sonnet and $0.35 for haiku, $4.7 together.

```bash
npm run bench:agent -- --questions bench/agent/questions-non-code.json --runs 3 --model sonnet --max-turns 25
npm run bench:agent -- --questions bench/agent/questions-non-code.json --runs 3 --model haiku --max-turns 25
```

### Rust questions (Phase 29)

[`bench/agent/questions-rust.json`](../bench/agent/questions-rust.json) has ten
questions over the axum + sqlx and actix-web + diesel RealWorld backends and the
Next.js frontend scanned with the axum backend:

- **routes:** the handlers of axum's `POST` / `DELETE
  /api/articles/:slug/favorite`; the handler and file of actix's `DELETE
  /api/articles/{article_title_slug}/favorite`;
- **callers / impact:** the callers of axum's `AuthUser::to_jwt`, and the
  routes a change to it reaches;
- **data:** the functions that write the `article_favorite` table;
- **env:** the variables axum's clap `Config` declares, and actix's three
  `env::var(env_key::X)` reads, whose keys are constants of another file;
- **traits:** the types that implement `FromRequest` (axum) and the
  `CommentRepository`, `FavoriteRepository` and `TagRepository` traits (actix);
- **frontend-api:** the frontend files that request `GET
  /api/profiles/:username` and the Rust function that handles it
  (`internet-realworld-rust-fullstack`).

Expected answers were written from the source (the `.route(..)` registrations,
call sites, the SQL of the favorite queries, the clap fields and `env::var`
reads, the `impl` blocks, the frontend's API calls), not from Concentrate output.

```bash
npm run bench:agent -- --questions bench/agent/questions-rust.json --runs 3 --model sonnet --max-turns 25
npm run bench:agent -- --questions bench/agent/questions-rust.json --runs 3 --model haiku --max-turns 25
```

Recorded 2026-11-11 with Claude Code 2.1.321, three runs each,
`--max-turns 25`, after the cost estimate was approved (about $4.6 estimated,
$3.91 spent)
([`agent-rust-sonnet-runs3-2026-11-11.json`](../bench/results/agent-rust-sonnet-runs3-2026-11-11.json),
[`agent-rust-haiku-runs3-2026-11-11.json`](../bench/results/agent-rust-haiku-runs3-2026-11-11.json)).
Per category, median input tokens (baseline → concentrate) and the runs in
which the agent called a Concentrate tool:

| Category | Runs | sonnet: correct | sonnet: input tokens | sonnet: MCP runs | haiku: correct | haiku: input tokens | haiku: MCP runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| routes | 6 | 6/6 / 6/6 | 83.0k → 102.8k (+24%) | 0/6 | 6/6 / 6/6 | 106.5k → 123.6k (+16%) | 0/6 |
| callers | 3 | 3/3 / 3/3 | 96.6k → 100.2k (+4%) | 3/3 | 3/3 / 3/3 | 99.3k → 104.4k (+5%) | 1/3 |
| impact | 3 | 3/3 / 3/3 | 99.2k → 136.4k (+37%) | 3/3 | 3/3 / 3/3 | 104.0k → 141.3k (+36%) | 3/3 |
| data | 3 | 3/3 / 3/3 | 131.1k → 100.8k (−23%) | 0/3 | 3/3 / 3/3 | 134.6k → 105.8k (−21%) | 2/3 |
| env | 6 | 6/6 / 6/6 | 97.8k → 100.6k (+3%) | 1/6 | 6/6 / 6/6 | 136.5k → 139.6k (+2%) | 6/6 |
| traits | 6 | 6/6 / 6/6 | 80.4k → 82.5k (+3%) | 0/6 | 6/6 / 6/6 | 83.3k → 85.5k (+3%) | 0/6 |
| frontend-api | 3 | 3/3 / 3/3 | 106.7k → 109.8k (+3%) | 3/3 | 3/3 / 3/3 | 191.8k → 113.3k (−41%) | 3/3 |

| | sonnet: baseline | sonnet: concentrate | haiku: baseline | haiku: concentrate |
| --- | ---: | ---: | ---: | ---: |
| Correct | 30/30 | 30/30 | 30/30 | 30/30 |
| Median input tokens | 97.7k | 100.5k | 102.9k | 113.2k |
| Median tool calls | 2 | 3 | 3 | 3 |
| Total cost (CLI estimate) | $1.84 | $1.82 | $0.13 | $0.12 |

- Both modes answered every question correctly in every run (60 of 60 per
  mode), so, as for Go, the samples are small enough for grep and the result is
  about cost, not correctness: input tokens are within a few percent of the
  baseline, except the impact questions, where the agent that used `impact_of`
  read more (+37% on sonnet, +36% on haiku), and the frontend question on haiku
  (−41%, `api_consumers` and `route_details` in 3 of 3 runs).
- The agent reached for Concentrate in 10 of 30 sonnet runs, on the callers,
  impact and frontend questions and once on actix's env question; it answered
  the route, table, trait and axum env questions from grep alone.
  A larger Rust repository, where grep cannot read everything, would be the
  fairer test; none is pinned yet.
