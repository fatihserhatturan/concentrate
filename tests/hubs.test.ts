import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { scanIntoStore } from "../src/adapters/cli/scan.js";
import { GRAPH_SUMMARY_URI, readResource } from "../src/adapters/mcp/resources.js";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { louvain } from "../src/core/graph/louvain.js";
import { openGraphStore } from "../src/composition/graph-store.js";

describe("louvain", () => {
  it("separates two dense groups joined by one edge, the same way every time", () => {
    const clique = (nodes: number[]) => nodes.flatMap((a, at) => nodes.slice(at + 1).map((b) => [a, b, 1] as const));
    const edges = [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), [3, 4, 1] as const];
    const result = louvain(8, edges);
    assert.deepEqual(new Set(result.slice(0, 4)).size, 1);
    assert.deepEqual(new Set(result.slice(4)).size, 1);
    assert.notEqual(result[0], result[4]);
    assert.deepEqual(louvain(8, edges), result);
  });

  it("keeps unconnected nodes apart and handles an empty graph", () => {
    assert.deepEqual(louvain(3, []), [0, 1, 2]);
    assert.deepEqual(louvain(0, []), []);
  });
});

// Two modules of files that import each other, with a single link between
// them, and a test file that must not count.
async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-hubs-"));
  const project = path.join(root, "project");
  const files: Record<string, string> = { "package.json": JSON.stringify({ name: "hubs-app" }) };
  const module = (dir: string, names: string[]) => {
    names.forEach((name, at) => {
      const imports = names.filter((_, other) => other !== at).map((other) => `import { ${other} } from './${other}';`).join("\n");
      files[`src/${dir}/${name}.ts`] = `${imports}\nexport function ${name}() { return [${names.filter((_, other) => other !== at).map((other) => `${other}()`).join(", ")}]; }\n`;
    });
  };
  module("billing", ["invoice", "ledger", "tax"]);
  module("search", ["index", "rank", "query"]);
  files["src/billing/invoice.ts"] += "import { rank } from '../search/rank';\nexport const link = () => rank();\n";
  files["tests/billing.test.ts"] = "import { invoice } from '../src/billing/invoice';\ninvoice();\n";
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), text);
  }
  const database = path.join(root, "graph");
  await scanIntoStore(project, { database, continueOnError: false, include: [], exclude: [], retryLock: true, cacheDir: path.join(root, "cache"), manifest: path.join(root, "m.json") });
  return openGraphStore(database);
}

describe("hubs and subsystems", () => {
  it("clusters files by edge density and lists the hubs", async () => {
    const store = await createStore();
    try {
      const overview = (await callMcpTool(store, "architecture_overview", { level: "subsystem" })).structuredContent as any;
      assert.deepEqual(overview.groups.map((group: any) => [group.name, group.files]), [["src/billing", 3], ["src/search", 3]]);
      assert.equal(overview.groups[0].topFiles.length, 3);
      assert.match(overview.note, /Louvain/u);
      // Hubs leave tests out and count distinct connected files.
      assert.ok(overview.hubs.files.every((hub: any) => !hub.file.startsWith("tests/")));
      assert.equal(overview.hubs.files[0].connections, 3);
      assert.ok(overview.hubs.files.some((hub: any) => hub.file === "src/search/rank.ts" && hub.importedBy === 3));
      assert.ok(overview.hubs.symbols[0].callers >= 2);

      const packages = (await callMcpTool(store, "architecture_overview", {})).structuredContent as any;
      assert.ok(packages.hubs.files.length > 0);
      await assert.rejects(() => callMcpTool(store, "architecture_overview", { level: "nope" }), /package, directory or subsystem/u);

      const summary = JSON.parse((await readResource(store, GRAPH_SUMMARY_URI)).contents[0]!.text);
      assert.equal(summary.hubs.files.length, 5);
    } finally {
      await store.close();
    }
  });
});
