import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode } from "../src/core/graph/model.js";
import { commandRefs, tokenize } from "../src/integrations/frameworks/scripts/commands.js";
import { scanPowerShell, scanShell, splitCommands } from "../src/integrations/frameworks/scripts/shell.js";

describe("shell scanner", () => {
  it("reads env expansions and leaves out locals, special parameters, comments and single quotes", () => {
    const scan = scanShell([
      "#!/bin/sh",
      "STAGE=${DEPLOY_STAGE:-staging}",
      "for f in *.sh; do echo \"$f $STAGE $1 $@ $# $HOME\"; done",
      "echo 'not $EXPANDED' # $COMMENTED",
      "echo \"$API_TOKEN\" ${REGION}",
      "read ANSWER; echo $ANSWER",
    ].join("\n"));
    assert.deepEqual(scan.reads.map((read) => [read.name, read.line]), [["DEPLOY_STAGE", 2], ["API_TOKEN", 5], ["REGION", 5]]);
  });

  it("treats export, declare -x and NAME=value before a command as declarations", () => {
    const scan = scanShell("export A=1\nexport B\nC=local\nD=1 make all\ndeclare -x E=2\nF=1; echo $F\n");
    assert.deepEqual(scan.declarations.map((declaration) => [declaration.name, declaration.line]), [["A", 1], ["B", 2], ["D", 4], ["E", 5]]);
    assert.deepEqual(scan.reads, []);
  });

  it("skips quoted heredoc bodies and reads unquoted ones; joins continuations", () => {
    const scan = scanShell("cat <<'ONE'\n$QUOTED\nONE\ncat <<TWO\n$OPEN\nTWO\necho a \\\n  $JOINED\ncat <<< $HERESTRING\n");
    assert.deepEqual(scan.reads.map((read) => [read.name, read.line]), [["OPEN", 5], ["JOINED", 7], ["HERESTRING", 9]]);
  });

  it("splits commands on &&, ||, ; and | outside quotes and $()", () => {
    assert.deepEqual(splitCommands("a x && b \"y;z\" | c; if d; then e $(f && g); fi"), ["a x", "b \"y;z\"", "c", "d", "e $(f && g)"]);
  });

  it("reads PowerShell $env: names, SetEnvironmentVariable and skips comments", () => {
    const scan = scanPowerShell("<# $env:BLOCK #>\n$env:MODE = 'x'\nWrite-Host $env:MODE ${env:REGION} # $env:LINE\n[Environment]::SetEnvironmentVariable('CACHE', 'y')\n$t = [Environment]::GetEnvironmentVariable(\"TOKEN\")\n& ./run.ps1\n");
    assert.deepEqual(scan.declarations.map((declaration) => declaration.name), ["MODE", "CACHE"]);
    assert.deepEqual(scan.reads.map((read) => read.name), ["MODE", "REGION", "TOKEN"]);
    assert.deepEqual(scan.commands.map((command) => command.text).filter((text) => text.includes("run.ps1")), ["./run.ps1"]);
  });
});

describe("command references", () => {
  const refs = (command: string) => commandRefs(command);
  it("reads what the common runners start", () => {
    assert.deepEqual(refs("node dist/index.js --port 1"), [{ kind: "file", path: "dist/index.js" }]);
    assert.deepEqual(refs("node -r dotenv/config src/worker.js"), [{ kind: "file", path: "src/worker.js" }]);
    assert.deepEqual(refs("cross-env NODE_ENV=dev tsx watch src/index.ts"), [{ kind: "file", path: "src/index.ts" }]);
    assert.deepEqual(refs("NODE_ENV=x npx ts-node scripts/x.ts"), [{ kind: "file", path: "scripts/x.ts" }]);
    assert.deepEqual(refs("go run ./cmd/server -v"), [{ kind: "go", path: "./cmd/server" }]);
    assert.deepEqual(refs("python manage.py migrate"), [{ kind: "file", path: "manage.py" }]);
    assert.deepEqual(refs("python3 -m app.tools.seed"), [{ kind: "python-module", module: "app.tools.seed" }]);
    assert.deepEqual(refs("./scripts/deploy.sh prod"), [{ kind: "file", path: "./scripts/deploy.sh" }]);
    assert.deepEqual(refs("bash -x scripts/a.sh"), [{ kind: "file", path: "scripts/a.sh" }]);
    assert.deepEqual(refs("pwsh -File ./a.ps1"), [{ kind: "file", path: "./a.ps1" }]);
  });

  it("reads package manager and make commands", () => {
    assert.deepEqual(refs("npm run build"), [{ kind: "npm", script: "build" }]);
    assert.deepEqual(refs("npm test"), [{ kind: "npm", script: "test" }]);
    assert.deepEqual(refs("npm --prefix web run build"), [{ kind: "npm", script: "build", dir: "web" }]);
    assert.deepEqual(refs("pnpm -r run lint"), [{ kind: "npm", script: "lint" }]);
    assert.deepEqual(refs("yarn build"), [{ kind: "npm", script: "build" }]);
    assert.deepEqual(refs("pnpm install"), []);
    assert.deepEqual(refs("make -C web bundle test"), [{ kind: "make", target: "bundle", dir: "web" }, { kind: "make", target: "test", dir: "web" }]);
    assert.deepEqual(refs("run-s lint test"), [{ kind: "npm", script: "lint" }, { kind: "npm", script: "test" }]);
    assert.deepEqual(refs("concurrently \"npm run a\" \"npm run b\""), [{ kind: "npm", script: "a" }, { kind: "npm", script: "b" }]);
  });

  it("does not link anything it cannot read", () => {
    assert.deepEqual(refs("echo hello"), []);
    assert.deepEqual(refs("tsc -p ."), []);
    assert.deepEqual(refs("node $ENTRY"), []);
    assert.deepEqual(tokenize("a \"b c\" 'd e' f\\ g"), ["a", "b c", "d e", "f g"]);
  });
});

describe("scripts and infrastructure in the graph", () => {
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;
  let byId: Map<string, GraphNode>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/scripts-infra"), { continueOnError: false });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });

  const name = (id: string): string => {
    const node = byId.get(id)!;
    if (node.label === "EntryPoint") return `${node.properties.kind}:${node.properties.trigger}${String(node.id).includes("web/") ? "@web" : ""}`;
    return node.label === "File" ? String(node.properties.relativePath) : String(node.properties.name);
  };
  const entrypoints = () => graph.nodes
    .filter((node) => node.label === "EntryPoint" && ["script", "make", "npm-script", "docker"].includes(String(node.properties.kind)))
    .map((node) => `${node.properties.kind}:${node.properties.trigger}`).sort();
  const runs = () => graph.relationships.filter((rel) => rel.type === "RUNS").map((rel) => `${name(rel.from)} -> ${name(rel.to)}`).sort();

  it("makes an EntryPoint for each script file, Makefile target, npm script and Dockerfile CMD / ENTRYPOINT", () => {
    assert.deepEqual(entrypoints(), [
      "docker:CMD", "docker:ENTRYPOINT",
      "make:all", "make:build", "make:bundle", "make:lint", "make:test",
      "npm-script:all", "npm-script:api", "npm-script:build", "npm-script:build", "npm-script:check", "npm-script:deploy", "npm-script:dev",
      "npm-script:migrate", "npm-script:prebuild", "npm-script:seed", "npm-script:serve", "npm-script:start", "npm-script:test", "npm-script:web", "npm-script:worker",
      "script:scripts/build.sh", "script:scripts/deploy.sh", "script:scripts/migrate.sh", "script:scripts/setup.ps1", "script:scripts/setup2.ps1",
    ]);
    const declared = graph.relationships.filter((rel) => rel.type === "DECLARES_ENTRYPOINT" && byId.get(rel.to)?.properties.library !== undefined && ["script", "make", "npm-script", "docker"].includes(String(byId.get(rel.to)?.properties.kind)));
    assert.ok(declared.every((rel) => byId.get(rel.from)?.label === "File"));
  });

  it("links an entrypoint to the file or entrypoint each command starts", () => {
    const links = runs();
    for (const expected of [
      "npm-script:dev -> src/index.ts",
      "npm-script:worker -> src/worker.ts",
      "npm-script:build -> scripts/postbuild.js",
      "npm-script:check -> npm-script:build",
      "npm-script:check -> npm-script:test",
      "npm-script:deploy -> script:scripts/deploy.sh",
      "npm-script:api -> cmd/server/main.go",
      "npm-script:migrate -> app/manage.py",
      "npm-script:seed -> app/tools/seed.py",
      "npm-script:all -> npm-script:dev",
      "npm-script:all -> npm-script:worker",
      "npm-script:web -> make:bundle@web",
      "make:all -> make:build",
      "make:build -> make:lint",
      "make:build -> cmd/server/main.go",
      "make:test -> script:scripts/migrate.sh",
      "script:scripts/deploy.sh -> script:scripts/migrate.sh",
      "script:scripts/deploy.sh -> make:test",
      "script:scripts/build.sh -> cmd/server/main.go",
      "script:scripts/setup.ps1 -> script:scripts/setup2.ps1",
      "docker:ENTRYPOINT -> script:scripts/deploy.sh",
      "docker:CMD -> src/index.ts",
    ]) assert.ok(links.includes(expected), expected);
    // `node dist/index.js`: the build output is not in the scan.
    assert.ok(!links.some((link) => link.startsWith("npm-script:start ->")));
    // pre and post hooks run around the script they name.
    assert.ok(links.includes("npm-script:build -> npm-script:prebuild"));
  });

  it("resolves `npm --prefix web run build` and `make -C web` against the web directory", () => {
    const webBuild = graph.nodes.find((node) => node.id === "entrypoint:npm-script:web/package.json:build")!;
    const root = graph.nodes.find((node) => node.id === "entrypoint:npm-script:package.json:web")!;
    const make = graph.nodes.find((node) => node.id === "entrypoint:make:web/Makefile:bundle")!;
    const rels = graph.relationships.filter((rel) => rel.type === "RUNS");
    assert.ok(rels.some((rel) => rel.from === root.id && rel.to === webBuild.id));
    assert.ok(rels.some((rel) => rel.from === root.id && rel.to === make.id));
    assert.ok(rels.some((rel) => rel.from === make.id && rel.to === webBuild.id));
  });

  it("reads env as USES_ENV from the entrypoint or file that reads it, without locals", () => {
    const reads = graph.relationships
      .filter((rel) => rel.type === "USES_ENV" && ["EntryPoint", "File"].includes(byId.get(rel.from)!.label) && String(rel.from).match(/script|make|npm|docker|Dockerfile/u))
      .map((rel) => `${name(rel.from)} ${name(rel.to)}`)
      .sort();
    assert.deepEqual(reads, [
      "Dockerfile BUILD_ID", "Dockerfile NODE_VERSION", "Dockerfile PORT",
      "make:build TARGET_OS",
      "npm-script:serve HOST", "npm-script:serve PORT",
      "script:scripts/deploy.sh API_TOKEN", "script:scripts/deploy.sh DEPLOY_STAGE", "script:scripts/deploy.sh HEREDOC_OPEN", "script:scripts/deploy.sh REGISTRY",
      "script:scripts/migrate.sh DATABASE_URL",
      "script:scripts/setup.ps1 AWS_REGION", "script:scripts/setup.ps1 GH_TOKEN", "script:scripts/setup.ps1 SETUP_MODE",
    ]);
  });

  it("declares env like .env files do: export, ENV / ARG, NAME=value before a command, $env: assignment", () => {
    const declared = graph.relationships
      .filter((rel) => rel.type === "DECLARES_ENV")
      .map((rel) => `${name(rel.to)} ${rel.properties.file}:${rel.properties.line}`)
      .sort();
    assert.deepEqual(declared, [
      "APP_ENV Dockerfile:4", "APP_VERSION scripts/deploy.sh:5", "BUILD_ID Dockerfile:3", "BUILD_TAGS Makefile:2", "CACHE_DIR scripts/setup.ps1:5",
      "DATABASE_URL scripts/deploy.sh:19", "DB_URL Makefile:14", "GOFLAGS Makefile:1", "LEGACY_VAR Dockerfile:5", "LOG_LEVEL package.json:6",
      "NODE_ENV package.json:6", "NODE_VERSION Dockerfile:2", "PORT Dockerfile:4", "REGISTRY scripts/deploy.sh:4", "SETUP_MODE scripts/setup.ps1:2",
    ]);
  });

  it("is idempotent: a second scan writes the same entrypoints and links", async () => {
    const again = await buildCodeGraph(path.resolve("fixtures/scripts-infra"), { continueOnError: false });
    assert.equal(again.relationships.filter((rel) => rel.type === "RUNS").length, graph.relationships.filter((rel) => rel.type === "RUNS").length);
  });
});
