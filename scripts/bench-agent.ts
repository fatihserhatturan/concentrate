/**
 * Agent benchmark: the same questions answered by Claude Code (`claude -p`)
 * with only its file tools (baseline) and with Concentrate's MCP tools added
 * (concentrate), compared on answer accuracy, tokens and tool calls.
 *
 *   npm run bench:agent -- [--runs 3] [--model name] [--question id]
 *     [--sample name] [--max-turns 30] [--out file.json] [--dry-run]
 *     [--claude path] [--rescore results.json] [--questions file.json]
 *
 * `npm run bench:agent` builds first. Each sample is scanned with the built
 * CLI into .concentrate/agent-bench/<sample>/; every question then runs
 * `runs` times per mode with the sample (or the question's cwd) as working
 * directory, and the medians are reported. Questions and expected answers are
 * in bench/agent/questions.json (--questions picks another set, such as
 * bench/agent/questions-hard.json); see docs/agent-benchmark.md.
 *
 * --dry-run prints the commands and writes the MCP configs without scanning
 * or calling claude. --claude names the CLI when it is not `claude` on PATH
 * (or set CLAUDE_BIN). Runs use the account claude is signed in with: a
 * subscription's usage limits, or API billing with ANTHROPIC_API_KEY.
 * --rescore scores the answers in an earlier results file again with the
 * current questions and scorer, without calling claude, and rewrites it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readSampleManifest, samplesDirectory } from "../src/adapters/cli/smoke.js";
import {
  claudeArgs,
  mcpConfig,
  modes,
  parseStreamJson,
  scoreAnswer,
  summarize,
  type Mode,
  type ModeSummary,
  type Question,
  type Range,
  type RunMetrics,
} from "./agent/agent.js";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    model: { type: "string" },
    question: { type: "string", multiple: true },
    sample: { type: "string" },
    "max-turns": { type: "string", default: "30" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    claude: { type: "string", default: process.env.CLAUDE_BIN ?? "claude" },
    rescore: { type: "string" },
    questions: { type: "string" },
  },
});
const runs = Number.parseInt(values.runs!, 10);
const maxTurns = Number.parseInt(values["max-turns"]!, 10);
const dryRun = values["dry-run"]!;
const claude = values.claude!;

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "dist/index.js");
const workRoot = path.join(root, ".concentrate/agent-bench");
const questionsPath = values.questions ?? path.join(root, "bench/agent/questions.json");
const { questions: allQuestions } = JSON.parse(await readFile(questionsPath, "utf8")) as { questions: Question[] };
const questions = allQuestions.filter((question) => (
  (!values.question || values.question.includes(question.id)) && (!values.sample || question.sample === values.sample)
));
if (questions.length === 0) throw new Error("No questions match --question / --sample");

type Run = RunMetrics & { correct: boolean; missing: string[] };
type QuestionResult = { id: string; sample: string; category: string; modes: Record<Mode, { summary: ReturnType<typeof summarize>; runs: Run[] }> };
type Summaries = Record<Mode, ReturnType<typeof summarize>>;
type AgentReport = {
  recordedAt: string;
  model: string;
  runs: number;
  maxTurns: number;
  totals: Summaries;
  // Per category, so a gain in one category is not read as an overall one.
  categories: Record<string, Summaries>;
  results: QuestionResult[];
};

const scoreRun = (metrics: RunMetrics, question: Question): Run => {
  const score = scoreAnswer(metrics.answer, question.expected);
  return { ...metrics, correct: score.correct && !metrics.isError, missing: score.missing };
};
const totalsOf = (results: readonly QuestionResult[]) =>
  Object.fromEntries(modes.map((mode) => [mode, summarize(results.flatMap((result) => result.modes[mode].runs))])) as Summaries;
const categoriesOf = (results: readonly QuestionResult[]) =>
  Object.fromEntries([...new Set(results.map((result) => result.category))].map((category) => (
    [category, totalsOf(results.filter((result) => result.category === category))]
  )));

if (values.rescore) {
  const report = JSON.parse(await readFile(values.rescore, "utf8")) as AgentReport;
  for (const result of report.results) {
    const question = allQuestions.find((entry) => entry.id === result.id);
    if (!question) throw new Error(`${result.id} is not in ${questionsPath}`);
    for (const mode of modes) {
      const rescored = result.modes[mode].runs.map((run) => scoreRun(run, question));
      result.modes[mode] = { summary: summarize(rescored), runs: rescored };
    }
  }
  report.totals = totalsOf(report.results);
  report.categories = categoriesOf(report.results);
  await writeFile(values.out ?? values.rescore, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  process.exit(0);
}

if (!dryRun) {
  const probe = spawnSync(claude, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.error(`The Claude Code CLI (${claude}) was not found. Install it and sign in, pass --claude <path>, or use --dry-run.`);
    process.exit(1);
  }
  console.error(`${claude} ${probe.stdout.trim()}`);
  if (!existsSync(cli)) throw new Error(`${cli} is missing; run npm run build`);
}

const manifest = await readSampleManifest();
const samples = [...new Set(questions.map((question) => question.sample))];

// One graph and one MCP config per sample and mode.
const configPaths = new Map<string, string>();
for (const sample of samples) {
  const projectPath = path.join(samplesDirectory(), sample);
  const sampleWork = path.join(workRoot, sample);
  const databasePath = path.join(sampleWork, "graph");
  await mkdir(sampleWork, { recursive: true });
  if (!dryRun) {
    if (!existsSync(projectPath)) throw new Error(`Sample ${sample} is missing at ${projectPath}; run npm run samples:fetch`);
    const entry = manifest.find((item) => item.name === sample);
    const scan = spawnSync(process.execPath, [
      cli, "scan", projectPath, "-d", databasePath,
      "--manifest", path.join(sampleWork, "manifest.json"), "--cache-dir", path.join(sampleWork, "cache"),
      ...(entry?.continueOnError ? ["--continue-on-error"] : []),
      ...(entry?.exclude ?? []).flatMap((pattern) => ["--exclude", pattern]),
      ...(entry?.apiOrigins ?? []).flatMap((origin) => ["--api-origin", origin]),
    ], { encoding: "utf8" });
    // Exit 1 is a scan that skipped unparsable files, expected for continueOnError samples.
    if (scan.status !== 0 && !(entry?.continueOnError && scan.status === 1)) {
      throw new Error(`Scanning ${sample} failed: ${scan.stderr || scan.stdout}`);
    }
    console.error(`scanned ${sample}`);
  }
  for (const mode of modes) {
    const configPath = path.join(sampleWork, `mcp-${mode}.json`);
    await writeFile(configPath, `${JSON.stringify(mcpConfig(mode, cli, databasePath), null, 2)}\n`);
    configPaths.set(`${sample}\0${mode}`, configPath);
  }
}

function runClaude(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdin closed: claude -p reads piped stdin as extra prompt otherwise.
    const child = spawn(claude, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => (stdout.includes('"type":"result"') ? resolve(stdout) : reject(new Error(`claude exited with ${code}: ${stderr.slice(-2000)}`))));
  });
}

// Applies the question's patch to the sample for one run and always reverts
// it, so the graph (scanned before) is the base the diff is taken against.
async function withPatch<T>(sampleRoot: string, patchPath: string | null, run: () => Promise<T>): Promise<T> {
  if (!patchPath) return run();
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", sampleRoot, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${sampleRoot}: ${result.stderr}`);
  };
  git(["apply", patchPath]);
  try {
    return await run();
  } finally {
    git(["apply", "-R", patchPath]);
  }
}

const results: QuestionResult[] = [];

for (const question of questions) {
  const sampleRoot = path.join(samplesDirectory(), question.sample);
  const cwd = path.join(sampleRoot, question.cwd ?? "");
  const patchPath = question.patch ? path.resolve(path.dirname(questionsPath), question.patch) : null;
  const perMode = {} as QuestionResult["modes"];
  for (const mode of modes) {
    const args = claudeArgs(mode, question.question, {
      mcpConfigPath: configPaths.get(`${question.sample}\0${mode}`)!,
      model: values.model,
      maxTurns,
      extraTools: question.extraTools,
    });
    if (dryRun) {
      if (question.patch) console.log(`# git -C ${sampleRoot} apply ${patchPath}  (reverted after each run)`);
      console.log(`# ${question.id} [${mode}] (cd ${cwd})\nclaude ${args.map((arg) => (/^[\w.,:/=@()-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ")}\n`);
      continue;
    }
    const modeRuns: Run[] = [];
    for (let run = 0; run < runs; run += 1) {
      const scored = scoreRun(parseStreamJson(await withPatch(sampleRoot, patchPath, () => runClaude(args, cwd))), question);
      modeRuns.push(scored);
      console.error(`${question.id} [${mode}] run ${run + 1}: ${scored.correct ? "correct" : `missing ${scored.missing.join(", ")}`}, ${scored.toolCalls} tool calls`);
    }
    perMode[mode] = { summary: summarize(modeRuns), runs: modeRuns };
  }
  if (!dryRun) results.push({ id: question.id, sample: question.sample, category: question.category, modes: perMode });
}
if (dryRun) process.exit(0);

const recordedAt = new Date().toISOString();
const outPath = values.out ?? path.join(root, "bench/results", `agent-${recordedAt.slice(0, 10)}.json`);
await mkdir(path.dirname(outPath), { recursive: true });
const report: AgentReport = { recordedAt, model: values.model ?? "default", runs, maxTurns, totals: totalsOf(results), categories: categoriesOf(results), results };
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.error(`wrote ${outPath}`);
printReport(report);

function printReport({ model, runs: runCount, totals, categories, results: rows }: AgentReport) {
  const k = (tokens: number) => `${(tokens / 1000).toFixed(1)}k`;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const usd = (value: number) => `${Math.round(value * 10000) / 10000}`;
  // "median (min–max)"
  const spread = (medianValue: number, { min, max }: Range, format: (value: number) => string) =>
    `${format(medianValue)} (${format(min)}–${format(max)})`;
  const change = (before: number, after: number) => (before === 0 ? "–" : `${after >= before ? "+" : "−"}${Math.abs(Math.round(((after - before) / before) * 100))}%`);
  const pair = (summaries: Summaries, cell: (summary: ModeSummary) => string) => modes.map((mode) => cell(summaries[mode])).join(" → ");
  const correct = (summary: ModeSummary) => `${summary.correct}/${summary.runs}`;

  console.log(`### Agent benchmark (${model}, ${runCount} runs per question and mode; median (min–max))\n`);
  console.log("| Question | Category | Correct (base / conc.) | Input tokens | Output tokens | Tool calls | Cost USD |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const result of rows) {
    const summaries = Object.fromEntries(modes.map((mode) => [mode, result.modes[mode].summary])) as Summaries;
    console.log(`| ${result.id} | ${result.category} | ${modes.map((mode) => correct(summaries[mode])).join(" / ")} | ${pair(summaries, (s) => spread(s.medianInputTokens, s.spread.inputTokens, k))} | ${pair(summaries, (s) => k(s.medianOutputTokens))} | ${pair(summaries, (s) => spread(s.medianToolCalls, s.spread.toolCalls, String))} | ${pair(summaries, (s) => usd(s.medianCostUsd))} |`);
  }

  console.log("\n### By category (all runs of the category; cost is the sum)\n");
  console.log("| Category | Runs | Correct (base / conc.) | Input tokens | Tool calls | Total cost |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [category, summaries] of Object.entries(categories)) {
    const [base, conc] = modes.map((mode) => summaries[mode]);
    console.log(`| ${category} | ${base!.runs} | ${correct(base!)} / ${correct(conc!)} | ${pair(summaries, (s) => spread(s.medianInputTokens, s.spread.inputTokens, k))} (${change(base!.medianInputTokens, conc!.medianInputTokens)}) | ${pair(summaries, (s) => spread(s.medianToolCalls, s.spread.toolCalls, String))} | ${pair(summaries, (s) => `$${s.totalCostUsd.toFixed(2)}`)} |`);
  }

  const [base, conc] = modes.map((mode) => totals[mode]!);
  console.log("\n### All runs\n");
  console.log("| | Baseline | Concentrate |");
  console.log("| --- | ---: | ---: |");
  console.log(`| Correct | ${correct(base!)} | ${correct(conc!)} |`);
  console.log(`| Median input tokens | ${spread(base!.medianInputTokens, base!.spread.inputTokens, k)} | ${spread(conc!.medianInputTokens, conc!.spread.inputTokens, k)} (${change(base!.medianInputTokens, conc!.medianInputTokens)}) |`);
  console.log(`| Median tool calls | ${spread(base!.medianToolCalls, base!.spread.toolCalls, String)} | ${spread(conc!.medianToolCalls, conc!.spread.toolCalls, String)} (${change(base!.medianToolCalls, conc!.medianToolCalls)}) |`);
  console.log(`| Median turns | ${base!.medianTurns} | ${conc!.medianTurns} (${change(base!.medianTurns, conc!.medianTurns)}) |`);
  console.log(`| Median wall time | ${spread(base!.medianDurationMs, base!.spread.durationMs, seconds)} | ${spread(conc!.medianDurationMs, conc!.spread.durationMs, seconds)} (${change(base!.medianDurationMs, conc!.medianDurationMs)}) |`);
  console.log(`| Total cost (CLI estimate) | $${base!.totalCostUsd.toFixed(2)} | $${conc!.totalCostUsd.toFixed(2)} |`);

  console.log("\n### MCP use (concentrate mode)\n");
  console.log("| Question | Runs with an MCP call | ToolSearch calls | MCP calls by tool |");
  console.log("| --- | ---: | ---: | --- |");
  const toolList = (tools: Record<string, number>) => Object.entries(tools).map(([tool, count]) => `\`${tool}\` ${count}`).join(", ") || "–";
  for (const result of rows) {
    const summary = result.modes.concentrate.summary;
    console.log(`| ${result.id} | ${summary.mcpRuns}/${summary.runs} | ${summary.toolSearchCalls} | ${toolList(summary.mcpTools)} |`);
  }
  console.log(`| **all** | ${conc!.mcpRuns}/${conc!.runs} | ${conc!.toolSearchCalls} | ${toolList(conc!.mcpTools)} |`);
}
