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

describe("Go env and config", () => {
  let graph: Graph;
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-env"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-go-env-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("finds os, viper and struct-tag reads with their readers", () => {
    assert.deepEqual(reads(graph), [
      ["<r.GET:/health:arg1>", "RELEASE", 13, "os.Getenv"],
      ["GET /health", "RELEASE", 13, "os.Getenv"],
      ["GET /region", "REGION", 20, "os.Getenv"],
      ["init", "REDIS_ADDR", 13, "viper.BindEnv"],
      // viper.Unmarshal: the struct's mapstructure keys, else field names ("-" skipped).
      ["Load", "APP_PORT", 28, "viper.Unmarshal"],
      ["Load", "APP_TIMEOUT", 28, "viper.Unmarshal"],
      // caarlos0/env: the function that parses the struct; envPrefix on the nested struct.
      ["Load", "DATABASE_MAX_CONNS", 7, "env struct tag"],
      ["Load", "DATABASE_URL", 6, "env struct tag"],
      ["Load", "PORT", 11, "env struct tag"],
      // envconfig: PREFIX_FIELD, split_words, a tag name, nested structs; ignored and unexported fields left out.
      ["LoadSpec", "WORKER_LIMITS_BURST", 6, "envconfig"],
      ["LoadSpec", "WORKER_MAX_WORKERS", 10, "envconfig"],
      ["LoadSpec", "WORKER_QUEUE", 11, "envconfig"],
      // viper: the prefix and key replacer of AutomaticEnv (BindEnv's explicit name above).
      ["LogLevel", "APP_LOG_LEVEL", 17, "viper.GetString"],
      ["main", "DB_HOST", 21, "os.ExpandEnv"],
      ["main", "DB_USER", 21, "os.ExpandEnv"],
      ["main", "DEBUG", 18, "os.LookupEnv"],
      ["region", "REGION", 20, "os.Getenv"],
    ]);
    // A package-level read belongs to the file.
    assert.ok(graph.relationships.some((rel) => rel.type === "USES_ENV" && rel.from === "file:main.go" && rel.to === "env:APP_MODE"));
    assert.ok(graph.nodes.every((node) => !("goViper" in node.properties)));
  });

  it("list_env_config lists Go reads and the .env variables no code reads", async () => {
    const region = await tool("list_env_config", { name: "REGION" });
    assert.deepEqual(region.envConfig.map((row: any) => [row.file, row.line, row.value]), [["server/server.go", 20, "os.Getenv"]]);
    const unread = await tool("list_env_config", { unread: true });
    const kinds = new Map(unread.envConfig.map((row: any) => [row.name, row.kind]));
    assert.equal(kinds.get("UNUSED_FLAG"), "unread");
    assert.equal(kinds.get("REGION"), "undeclared");
    // Declared in .env.example and read.
    assert.equal(kinds.has("PORT"), false);
    assert.equal(kinds.has("APP_LOG_LEVEL"), false);
  });

  it("impact_of reaches the env a handler reads", async () => {
    const impact = await tool("impact_of", { symbol: "region" });
    assert.deepEqual(impact.envVars.map((row: any) => row.name), ["REGION"]);
    assert.deepEqual(impact.routes.map((row: any) => row.fullPath), ["/region"]);
  });

  it("scores env reads against labels", () => {
    const score = compareEnv(graph, {
      scope: ["main.go"],
      items: [
        { file: "main.go", line: 11, name: "APP_MODE", function: null },
        { file: "main.go", line: 18, name: "DEBUG", function: "main" },
        { file: "main.go", line: 21, name: "DB_HOST", function: "main" },
        { file: "main.go", line: 21, name: "DB_USER", function: "main" },
        { file: "main.go", line: 30, name: "MISSING", function: "main" },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [4, 0, 1]);
  });
});
