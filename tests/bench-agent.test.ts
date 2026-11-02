import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  claudeArgs,
  mcpConfig,
  median,
  parseStreamJson,
  scoreAnswer,
  summarize,
  totalInputTokens,
  type Question,
} from "../scripts/agent/agent.js";

describe("agent benchmark: scoring", () => {
  it("needs every mustInclude string and one string of each anyOf group", () => {
    const expected = { mustInclude: ["/cats/:id"], anyOf: [["POST /cats"], ["DELETE"]] };
    assert.deepEqual(scoreAnswer("Writes: **POST `/cats`**, `POST /cats/:id` and DELETE /cats/:id", expected), { correct: true, missing: [] });
    assert.deepEqual(scoreAnswer("POST /cats/:id only", expected), { correct: false, missing: ["DELETE"] });
    assert.deepEqual(scoreAnswer("nothing", { mustInclude: ["createUser", "login"] }), { correct: false, missing: ["createUser", "login"] });
  });

  it("reads a Markdown table row as text", () => {
    assert.equal(scoreAnswer("| Method | Path |\n|---|---|\n| POST | `/cats` |", { mustInclude: ["POST /cats"] }).correct, true);
  });

  it("ignores case, quotes and line breaks", () => {
    assert.equal(scoreAnswer("The `JWT_SECRET`\nand \"node_env\"", { mustInclude: ["jwt_secret", "NODE_ENV"] }).correct, true);
  });
});

describe("agent benchmark: stream-json", () => {
  const transcript = [
    JSON.stringify({ type: "system", subtype: "init", tools: ["Read", "mcp__concentrate__list_routes"] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking" }, { type: "tool_use", name: "mcp__concentrate__list_routes", input: {} }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "[]" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }, { type: "tool_use", name: "Read", input: {} }] } }),
    "not json",
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "GET /users",
      num_turns: 3,
      duration_ms: 4200,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 },
    }),
  ].join("\n");

  it("reads the answer, usage and tool calls", () => {
    const run = parseStreamJson(transcript);
    assert.equal(run.answer, "GET /users");
    assert.equal(run.isError, false);
    assert.deepEqual([run.turns, run.durationMs, run.costUsd], [3, 4200, 0.0123]);
    assert.deepEqual(run.toolsByName, { mcp__concentrate__list_routes: 1, Read: 2 });
    assert.equal(run.toolCalls, 3);
    assert.equal(totalInputTokens(run), 6010);
  });

  it("marks runs that hit the turn limit as errors and rejects transcripts without a result", () => {
    const capped = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 30 });
    assert.equal(parseStreamJson(capped).isError, true);
    assert.throws(() => parseStreamJson("{\"type\":\"system\"}"), /No result event/);
  });
});

describe("agent benchmark: commands", () => {
  const options = { mcpConfigPath: "/tmp/mcp.json", maxTurns: 30 };
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

  it("gives both modes the file tools and only concentrate mode the MCP server", () => {
    const baseline = claudeArgs("baseline", "Q?", options);
    const concentrate = claudeArgs("concentrate", "Q?", { ...options, model: "sonnet" });
    assert.deepEqual(baseline.slice(0, 2), ["-p", "Q?"]);
    for (const args of [baseline, concentrate]) {
      assert.equal(flag(args, "--output-format"), "stream-json");
      assert.ok(args.includes("--verbose") && args.includes("--strict-mcp-config"));
      assert.match(flag(args, "--disallowedTools")!, /Edit,Write/);
    }
    assert.equal(flag(baseline, "--allowedTools"), "Read,Grep,Glob,Bash(ls:*)");
    assert.equal(flag(concentrate, "--allowedTools"), "Read,Grep,Glob,Bash(ls:*),mcp__concentrate");
    assert.equal(baseline.includes("--model"), false);
    assert.equal(flag(concentrate, "--model"), "sonnet");
  });

  it("writes an empty MCP config for the baseline", () => {
    assert.deepEqual(mcpConfig("baseline", "/cli.js", "/graph"), { mcpServers: {} });
    assert.deepEqual(mcpConfig("concentrate", "/cli.js", "/graph").mcpServers.concentrate?.args, ["/cli.js", "mcp", "-d", "/graph"]);
  });
});

describe("agent benchmark: summaries", () => {
  it("takes medians per mode", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([]), 0);
    const run = (correct: boolean, toolCalls: number) => ({
      answer: "", isError: false, turns: toolCalls + 1, durationMs: 1000, costUsd: 0.01, inputTokens: 100,
      outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 900, toolCalls, toolsByName: {}, correct,
    });
    const summary = summarize([run(true, 2), run(false, 8), run(true, 4)]);
    assert.deepEqual([summary.runs, summary.correct, summary.medianToolCalls, summary.medianInputTokens, summary.medianTurns], [3, 2, 4, 1000, 5]);
  });

  it("reports the spread, the total cost and MCP use", () => {
    const run = (toolCalls: number, costUsd: number, toolsByName: Record<string, number>) => ({
      answer: "", isError: false, turns: 2, durationMs: toolCalls * 1000, costUsd, inputTokens: toolCalls * 100,
      outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, toolCalls, toolsByName, correct: true,
    });
    const summary = summarize([
      run(2, 0.01, { ToolSearch: 1, mcp__concentrate__impact_of: 1 }),
      run(5, 0.04, { Grep: 5 }),
      run(3, 0.02, { ToolSearch: 1, mcp__concentrate__api_consumers: 1, mcp__concentrate__impact_of: 1 }),
    ]);
    assert.deepEqual(summary.spread.toolCalls, { min: 2, max: 5 });
    assert.deepEqual(summary.spread.inputTokens, { min: 200, max: 500 });
    assert.deepEqual(summary.spread.costUsd, { min: 0.01, max: 0.04 });
    assert.equal(summary.totalCostUsd, 0.07);
    assert.equal(summary.mcpRuns, 2);
    assert.equal(summary.toolSearchCalls, 2);
    assert.deepEqual(Object.entries(summary.mcpTools), [["impact_of", 2], ["api_consumers", 1]]);
  });
});

for (const file of ["questions.json", "questions-hard.json", "questions-frontend.json"]) it(`${file} entries are complete and unique`, () => {
  const { questions } = JSON.parse(readFileSync(path.join(import.meta.dirname, "../bench/agent", file), "utf8")) as { questions: Question[] };
  assert.ok(questions.length >= 6);
  assert.equal(new Set(questions.map((question) => question.id)).size, questions.length);
  const samples = (JSON.parse(readFileSync(path.join(import.meta.dirname, "../scripts/samples.json"), "utf8")) as { samples: Array<{ name: string }> }).samples.map((sample) => sample.name);
  for (const question of questions) {
    assert.ok(samples.includes(question.sample), `${question.id}: unknown sample ${question.sample}`);
    assert.ok(question.question.endsWith("?") || question.question.endsWith("."), question.id);
    assert.ok(question.expected.mustInclude.length > 0, question.id);
  }
});
