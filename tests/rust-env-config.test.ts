import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { compareEnv } from "../scripts/accuracy/compare.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

// [reader, env name, line, access] for the USES_ENV of Functions and Routes.
function reads(graph: Graph): Array<[string, string, number, string]> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "USES_ENV" && byId.get(rel.from)?.label !== "File")
    .map((rel) => {
      const from = byId.get(rel.from)!;
      const reader = from.label === "Route" ? `${from.properties.method} ${from.properties.fullPath}` : String(from.properties.name);
      return [reader, String(byId.get(rel.to)?.properties.name), Number(rel.properties.line), String(rel.properties.access)] as [string, string, number, string];
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

describe("Rust env and config", () => {
  let graph: Graph;
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/rust-env"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-rust-env-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("finds env, clap, config and envy reads with their readers", () => {
    assert.deepEqual(reads(graph), [
      // clap builder `.env(..)`.
      ["builder", "API_TOKEN", 18, "clap env"],
      ["GET /region", "REGION", 21, "env::var"],
      // the config crate: prefix, separator, serde rename, nested struct and get_string.
      ["load", "APP_LOG_LEVEL", 22, "config get_string"],
      ["load", "APP_LOG_LEVEL", 14, "config try_deserialize"],
      ["load", "APP_SERVER__HOST", 6, "config try_deserialize"],
      ["load", "APP_SERVER__LISTEN_PORT", 8, "config try_deserialize"],
      ["main", "DEBUG", 13, "env::var_os"],
      ["main", "GIT_SHA", 14, "option_env!"],
      ["main", "PORT", 12, "env::var"],
      // clap derive: the function that parses the struct; a bare `env` is the field name.
      ["parse", "DATABASE_URL", 6, "clap env"],
      ["parse", "WORKER_COUNT", 8, "clap env"],
      ["region", "REGION", 21, "env::var"],
      // a key that is a constant of another file.
      ["shared", "SHARED_KEY", 26, "env::var"],
      // envy: a typed let, the prefix and serde rename.
      ["worker", "WORKER_MAX_JOBS", 30, "envy"],
      ["worker", "WORKER_QUEUE_NAME", 28, "envy"],
    ]);
    // An item-level read (`env!` in a static) belongs to the file.
    assert.ok(graph.relationships.some((rel) => rel.type === "USES_ENV" && rel.from === "file:src/main.rs" && rel.to === "env:BUILD_TAG"));
  });

  it("list_env_config lists Rust reads and the .env variables no code reads", async () => {
    const region = await tool("list_env_config", { name: "REGION" });
    assert.deepEqual(region.envConfig.map((row: any) => [row.file, row.line, row.value]), [["src/main.rs", 21, "env::var"]]);
    const unread = await tool("list_env_config", { unread: true });
    const kinds = new Map(unread.envConfig.map((row: any) => [row.name, row.kind]));
    assert.equal(kinds.get("UNUSED_FLAG"), "unread");
    assert.equal(kinds.get("REGION"), "undeclared");
    assert.equal(kinds.has("PORT"), false);
    assert.equal(kinds.has("DATABASE_URL"), false);
  });

  it("impact_of reaches the env a handler reads", async () => {
    const impact = await tool("impact_of", { symbol: "region" });
    assert.deepEqual(impact.envVars.map((row: any) => row.name), ["REGION"]);
    assert.deepEqual(impact.routes.map((row: any) => row.fullPath), ["/region"]);
  });

  it("scores env reads against labels", () => {
    const score = compareEnv(graph, {
      scope: ["src/main.rs"],
      items: [
        { file: "src/main.rs", line: 8, name: "BUILD_TAG", function: null },
        { file: "src/main.rs", line: 12, name: "PORT", function: "main" },
        { file: "src/main.rs", line: 13, name: "DEBUG", function: "main" },
        { file: "src/main.rs", line: 14, name: "GIT_SHA", function: "main" },
        { file: "src/main.rs", line: 21, name: "REGION", function: "region" },
        { file: "src/main.rs", line: 27, name: "SHARED_KEY", function: "shared" },
        { file: "src/main.rs", line: 30, name: "MISSING", function: "main" },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [6, 0, 1]);
  });
});
