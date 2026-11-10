import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

describe("scripts and infrastructure in the MCP tools", () => {
  let store: GraphStore;
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-scripts-"));
    const graph = await buildCodeGraph(path.resolve("fixtures/scripts-infra"), { continueOnError: false });
    store = await GraphStore.open(path.join(root, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> =>
    JSON.parse((await callMcpTool(store, name, args)).content[0]!.text) as Record<string, any>;
  const runners = (result: Record<string, any>): string[] =>
    (result.runners ?? []).map((runner: any) => `${runner.depth}:${runner.kind}:${runner.trigger}@${runner.file}`);

  it("list_entrypoints lists scripts, targets, services and jobs with what they run", async () => {
    // `file` matches by path suffix, so web/package.json comes too.
    const npm = ((await call("list_entrypoints", { kind: "npm-script", file: "package.json" })).entrypoints as any[]).filter((entry) => entry.file === "package.json");
    const byTrigger = new Map(npm.map((entry) => [entry.trigger, entry]));
    assert.deepEqual(byTrigger.get("build").runs, [
      { file: "scripts/postbuild.js", command: "node scripts/postbuild.js" },
      { file: "package.json", entrypoint: "npm-script:prebuild", command: "pre hook" },
    ]);
    assert.equal(byTrigger.get("dev").handlerName, "cross-env NODE_ENV=development LOG_LEVEL=debug tsx watch src/index.ts");
    assert.deepEqual(byTrigger.get("deploy").runs, [{ file: "scripts/deploy.sh", entrypoint: "script:scripts/deploy.sh", command: "./scripts/deploy.sh" }]);
    // No RUNS, no `runs` key; and the internal id is not returned.
    assert.equal("runs" in byTrigger.get("test"), false);
    assert.ok(npm.every((entry) => !("id" in entry)));

    const services = (await call("list_entrypoints", { kind: "compose-service" })).entrypoints as any[];
    assert.deepEqual(services.map((service) => [service.trigger, (service.runs ?? []).map((run: any) => run.file)]), [
      ["api", ["api/Dockerfile.dev", "src/index.ts"]],
      ["worker", ["Dockerfile", "scripts/deploy.sh"]],
      ["db", []],
    ]);
    const jobs = (await call("list_entrypoints", { kind: "ci-job" })).entrypoints as any[];
    assert.deepEqual(jobs.map((job) => `${job.file}:${job.trigger}`), [
      ".github/workflows/ci.yml:build", ".github/workflows/ci.yml:test", ".github/workflows/release.yml:ci", ".github/workflows/release.yml:publish",
    ]);
  });

  it("impact_of on a Go package lists what runs it, and what runs those", async () => {
    const impact = await call("impact_of", { file: "cmd/server" });
    assert.deepEqual(runners(impact), [
      "1:make:build@Makefile",
      "1:npm-script:api@package.json",
      "1:script:scripts/build.sh@scripts/build.sh",
      "2:make:all@Makefile",
      "2:script:scripts/deploy.sh@scripts/deploy.sh",
      "3:ci-job:build@.github/workflows/ci.yml",
      "3:compose-service:worker@docker-compose.yml",
      "3:docker:ENTRYPOINT@Dockerfile",
      "3:npm-script:deploy@package.json",
      "3:script:scripts/setup.ps1@scripts/setup.ps1",
      "4:ci-job:ci@.github/workflows/release.yml",
      "4:ci-job:publish@.github/workflows/release.yml",
    ]);
    assert.equal(impact.runners[0].command, "go build ./cmd/server");
    assert.equal(impact.runners[0].runs, "cmd/server/main.go");
    // The function side is still there.
    assert.deepEqual(impact.seeds.map((seed: any) => seed.name), ["main"]);
  });

  it("impact_of on a script says what breaks if it moves, without any function in it", async () => {
    const impact = await call("impact_of", { file: "scripts/deploy.sh" });
    assert.deepEqual(impact.seeds, []);
    assert.match(impact.note, /runners are the scripts/u);
    assert.deepEqual(runners(impact), [
      "1:ci-job:build@.github/workflows/ci.yml",
      "1:compose-service:worker@docker-compose.yml",
      "1:docker:ENTRYPOINT@Dockerfile",
      "1:npm-script:deploy@package.json",
      "1:script:scripts/setup.ps1@scripts/setup.ps1",
      "2:ci-job:ci@.github/workflows/release.yml",
      "2:ci-job:publish@.github/workflows/release.yml",
    ]);
  });

  it("follows a Dockerfile and a reusable workflow: whoever runs the file runs what it declares", async () => {
    // `api/Dockerfile.dev` has the CMD that starts src/index.ts; the api service builds it.
    const impact = await call("impact_of", { file: "src/index.ts" });
    const list = runners(impact);
    assert.ok(list.includes("1:docker:CMD@api/Dockerfile.dev"));
    assert.ok(list.includes("1:compose-service:api@docker-compose.yml"));
    // release.yml's `ci` job uses ci.yml, so it runs ci.yml's jobs.
    assert.ok(list.includes("4:ci-job:ci@.github/workflows/release.yml"));
  });

  it("maxDepth limits the chain, and a file nothing runs has no runners", async () => {
    assert.deepEqual(runners(await call("impact_of", { file: "scripts/build.sh", maxDepth: 1 })), ["1:script:scripts/deploy.sh@scripts/deploy.sh"]);
    const none = await call("impact_of", { file: "scripts/setup2.ps1x" });
    assert.equal("runners" in none, false);
  });
});
