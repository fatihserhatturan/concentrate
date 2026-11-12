import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCommandArgs } from "../src/adapters/cli/args.js";
import { scanIntoStore } from "../src/adapters/cli/scan.js";
import { affectedTests } from "../src/adapters/mcp/agent-tools/affected.js";
import { parseListedTools } from "../src/adapters/mcp/tools.js";
import { openGraphStore } from "../src/composition/graph-store.js";
import { program } from "../src/program.js";
import { startMcpServer } from "./helpers/mcp-stdio.js";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "affected-app" }),
  "src/util.ts": "export function slug(text: string) { return text.toLowerCase(); }\n",
  "src/service.ts": "import { slug } from './util';\nexport function title(text: string) { return slug(text); }\n",
  "src/standalone.ts": "export function lonely() { return 1; }\n",
  "src/boot.ts": "import { title } from './service';\nexport const first = title('A');\n",
  "tests/service.test.ts": "import { title } from '../src/service';\ntitle('x');\n",
  "tests/boot.test.ts": "import '../src/boot';\n",
  "tests/lonely.test.ts": "import { lonely } from '../src/standalone';\nlonely();\n",
};

async function createGraph() {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-affected-"));
  const projectPath = path.join(root, "project");
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(projectPath, file)), { recursive: true });
    await writeFile(path.join(projectPath, file), text);
  }
  const database = path.join(root, "graph");
  await scanIntoStore(projectPath, {
    database,
    continueOnError: false,
    include: [],
    exclude: [],
    retryLock: true,
    cacheDir: path.join(root, "cache"),
    manifest: path.join(root, "scan-manifest.json"),
  });
  return { database };
}

describe("affected tests", () => {
  it("follows imports and calls from changed files to the tests that reach them", async () => {
    const { database } = await createGraph();
    const store = await openGraphStore(database);
    try {
      const util = await affectedTests(store, ["src/util.ts"]);
      assert.deepEqual(util.changed, ["src/util.ts"]);
      assert.deepEqual(util.tests, [
        { file: "tests/service.test.ts", depth: 2, via: "src/util.ts" },
        { file: "tests/boot.test.ts", depth: 3, via: "src/util.ts" },
      ]);

      // A changed test is affected itself, and an argument that matches nothing is reported.
      const mixed = await affectedTests(store, ["tests/lonely.test.ts", "src/missing.ts"]);
      assert.deepEqual(mixed.tests, [{ file: "tests/lonely.test.ts", depth: 0, via: "tests/lonely.test.ts" }]);
      assert.deepEqual(mixed.unmatched, ["src/missing.ts"]);

      // The depth limit and directories.
      assert.deepEqual((await affectedTests(store, ["src/util.ts"], 2)).tests.map((test) => test.file), ["tests/service.test.ts"]);
      assert.deepEqual((await affectedTests(store, ["src/standalone.ts"])).tests.map((test) => test.file), ["tests/lonely.test.ts"]);
      assert.equal((await affectedTests(store, ["src"])).tests.length, 3);
    } finally {
      await store.close();
    }
  });
});

describe("variadic CLI arguments", () => {
  it("passes the files as one array, possibly empty", () => {
    const affected = program.commands.find((command) => command.name === "affected")!;
    assert.deepEqual(parseCommandArgs(affected, ["a.ts", "b.ts", "--stdin"]).positionals, [["a.ts", "b.ts"]]);
    assert.deepEqual(parseCommandArgs(affected, ["--stdin"]).positionals, [[]]);
  });
});

describe("mcp --tools", () => {
  it("rejects unknown names", () => {
    assert.deepEqual([...parseListedTools("graph_stats, list_routes")], ["graph_stats", "list_routes"]);
    assert.throws(() => parseListedTools("graph_stats,nope"), /Unknown tool nope/);
    assert.throws(() => parseListedTools(" , "), /at least one/);
  });

  it("lists only the named tools but still answers the others", async () => {
    const { database } = await createGraph();
    const server = startMcpServer(database, ["--tools", "graph_stats,find_callers"]);
    try {
      const listed = await server.request("tools/list", {});
      assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name), ["graph_stats", "find_callers"]);
      const result = await server.request("tools/call", { name: "find_definitions", arguments: { name: "slug" } });
      assert.equal(result.structuredContent.definitions.length, 1);
    } finally {
      await server.close();
    }
  });
});
