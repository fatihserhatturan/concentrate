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
npm run bench:agent -- --rescore bench/results/agent-runs3-2026-10-29.json
```

It needs the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)
on `PATH` (or `--claude <path>`), signed in. Runs use that account: a
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

The totals line gives the same medians over all runs of a mode. Results go to
`bench/results/agent-<date>.json` with every run's answer and tool counts.


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
- **The agent used the MCP tools in 21 of 39 runs** (`list_env_config`,
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
- **Repository-wide listings get a little cheaper:** the env question took
  two calls instead of three at about 25% fewer tokens. For models and
  DELETE routes the agent used grep in both modes and costs were close.

The one-run measurement of this set
([`bench/results/agent-hard-2026-10-29.json`](../bench/results/agent-hard-2026-10-29.json))
had 4/6 → 5/6 correct, −23% median input tokens and −43% median tool calls.
