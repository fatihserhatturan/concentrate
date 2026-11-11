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

// `reader env line access` of the USES_ENV of Functions, or of Files with `file`.
function reads(graph: Graph, from: "Function" | "File"): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "USES_ENV" && byId.get(rel.from)?.label === from)
    .map((rel) => {
      const node = byId.get(rel.from)!;
      const reader = from === "File" ? String(node.properties.relativePath) : String(node.properties.name);
      return `${reader} ${byId.get(rel.to)!.properties.name} ${rel.properties.line} ${rel.properties.access}`;
    })
    .sort();
}

describe("Python env and config", () => {
  let env: Graph;
  let django: Graph;
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    env = await buildCodeGraph(path.resolve("fixtures/python-env"), { continueOnError: false });
    django = await buildCodeGraph(path.resolve("fixtures/python-django-orm"), { continueOnError: false });
    store = await GraphStore.open(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-python-env-")), "graph"));
    await store.reset();
    await store.write(env.nodes, env.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("reads os.environ, getenv, dotenv, environs and decouple, with keys from constants", () => {
    assert.deepEqual(reads(env, "Function").filter((row) => !/pydantic|settings\./u.test(row)), [
      "debug DEBUG 21 os.environ",
      "debug TRACE 21 os.environ in",
      "dotenv FROM_DOTENV 42 dotenv_values",
      "dotenv FROM_DOTENV_2 42 dotenv_values.get",
      "dotenv KEY_FROM_FILE 42 get_key",
      "local LOCAL_FLAG 34 os.getenv",
      "mail MAIL_HOST 38 env.str",
      "mail MAIL_PORT 38 env.int",
      "mail MAIL_USER 38 env",
      // a key that is a constant of another file.
      "region APP_REGION 30 os.getenv",
      "token API_TOKEN 26 os.getenv",
      "token FALLBACK_TOKEN 26 os.environ.get",
    ]);
    const files = reads(env, "File");
    // Module-level reads belong to the file; a write and a computed key are not reads.
    assert.ok(files.includes("app/reads.py PORT 15 os.environ.get"));
    assert.ok(files.includes("app/reads.py REQUEST_TIMEOUT 16 decouple config"));
    assert.ok(!files.some((row) => row.includes("WRITTEN_ONLY")));
  });

  it("reads pydantic settings with prefixes, aliases and inheritance where they are built and used", () => {
    const functions = reads(env, "Function").filter((row) => /pydantic|settings\./u.test(row));
    assert.deepEqual(functions, [
      "connections APP_MAX_CONNECTIONS 18 settings.max_connections",
      "get_legacy LEGACY_NAME 10 pydantic settings",
      "secret SERVICE_SECRET 14 settings.secret_key",
    ]);
    const files = reads(env, "File").filter((row) => row.startsWith("app/main.py") && row.endsWith("pydantic settings"));
    assert.deepEqual(files, [
      "app/main.py APP_DATABASE_URL 5 pydantic settings",
      "app/main.py APP_DEBUG 5 pydantic settings",
      "app/main.py APP_MAX_CONNECTIONS 5 pydantic settings",
      // `Field(env=...)`, then `validation_alias`: a prefix does not apply to them.
      "app/main.py CACHE_URL 5 pydantic settings",
      "app/main.py LEGACY_NAME 10 pydantic settings",
      "app/main.py SERVICE_SECRET 5 pydantic settings",
    ]);
  });

  it("reads Django settings.X through the variables its settings module reads", () => {
    assert.deepEqual(reads(django, "Function"), ["debug_mode DJANGO_DEBUG 9 settings.DEBUG", "sender DJANGO_SECRET 5 settings.SECRET_KEY"]);
    const files = reads(django, "File").filter((row) => row.startsWith("config/"));
    assert.deepEqual(files, ["config/settings.py DATABASE_URL 9 env.db", "config/settings.py DJANGO_DEBUG 8 env.bool", "config/settings.py DJANGO_SECRET 7 os.environ"]);
  });

  it("list_env_config and impact_of answer for Python", async () => {
    const region = await tool("list_env_config", { name: "APP_REGION" });
    assert.deepEqual(region.envConfig.map((row: any) => [row.file, row.line, row.value]), [["app/reads.py", 30, "os.getenv"]]);
    const impact = await tool("impact_of", { symbol: "region" });
    assert.deepEqual(impact.envVars.map((row: any) => row.name), ["APP_REGION"]);
  });

  it("scores env reads against labels", () => {
    const score = compareEnv(env, {
      scope: ["app/reads.py"],
      items: [
        { file: "app/reads.py", line: 15, name: "PORT", function: null },
        { file: "app/reads.py", line: 16, name: "REQUEST_TIMEOUT", function: null },
        { file: "app/reads.py", line: 21, name: "DEBUG", function: "debug" },
        { file: "app/reads.py", line: 21, name: "TRACE", function: "debug" },
        { file: "app/reads.py", line: 26, name: "API_TOKEN", function: "token" },
        { file: "app/reads.py", line: 26, name: "FALLBACK_TOKEN", function: "token" },
        { file: "app/reads.py", line: 30, name: "APP_REGION", function: "region" },
        { file: "app/reads.py", line: 34, name: "LOCAL_FLAG", function: "local" },
        { file: "app/reads.py", line: 38, name: "MAIL_HOST", function: "mail" },
        { file: "app/reads.py", line: 38, name: "MAIL_PORT", function: "mail" },
        { file: "app/reads.py", line: 38, name: "MAIL_USER", function: "mail" },
        { file: "app/reads.py", line: 42, name: "FROM_DOTENV", function: "dotenv" },
        { file: "app/reads.py", line: 42, name: "FROM_DOTENV_2", function: "dotenv" },
        { file: "app/reads.py", line: 42, name: "KEY_FROM_FILE", function: "dotenv" },
        // computed keys are not found.
        { file: "app/reads.py", line: 46, name: "DYNAMIC", function: "dynamic" },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [14, 0, 1]);
  });
});
