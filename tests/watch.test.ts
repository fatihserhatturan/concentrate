import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { startWatch, type WatchScan } from "../src/adapters/cli/watch.js";
import { GraphStore } from "../src/adapters/store/store.js";

// fs.watch can deliver events late, split one burst of writes over two scans,
// or report a write made just before the watcher started. idle() only knows
// about events already delivered, so wait until a scan after `from` matches.
async function scanWhere(
  handle: { idle(): Promise<void> },
  scans: WatchScan[],
  from: number,
  matches: (scan: WatchScan) => Promise<boolean>,
): Promise<WatchScan> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    await handle.idle();
    const scan = scans.at(-1);
    if (scans.length > from && scan && await matches(scan)) return scan;
    if (Date.now() > deadline) throw new Error("no matching watch scan within 10 s");
    await sleep(25);
  }
}

async function functionNames(store: GraphStore): Promise<string[]> {
  const rows = await store.query("MATCH (fn:Function) RETURN fn.name AS name ORDER BY name");
  return rows.map((row) => String((row as { name: unknown }).name));
}

describe("watch", () => {
  it("rescans on changes and keeps the last graph when a scan fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-watch-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/a.ts"), "export function one() { return 1; }\n");
    // Outputs inside the project: the watcher must not rescan because of its own writes.
    const outputs = path.join(root, ".concentrate");
    const options = {
      database: path.join(outputs, "graph"),
      cacheDir: path.join(outputs, "cache"),
      manifest: path.join(outputs, "manifest.json"),
      continueOnError: false,
      include: [],
      exclude: [],
      retryLock: true,
      debounce: 50,
    };

    const scans: WatchScan[] = [];
    const handle = startWatch(root, options, (scan) => scans.push(scan));
    try {
      let scan = await scanWhere(handle, scans, 0, async () => true);
      assert.equal(scan.result?.report.status, "success");
      // A reader opened once, like a running MCP server, sees every new graph.
      const reader = await GraphStore.open(options.database);
      assert.deepEqual(await functionNames(reader), ["one"]);
      const names = async () => (await functionNames(reader)).join(",");

      let from = scans.length;
      await writeFile(path.join(root, "src/a.ts"), "export function two() { return 2; }\n");
      await writeFile(path.join(root, "src/b.ts"), "export function three() { return 3; }\n");
      scan = await scanWhere(handle, scans, from, async () => await names() === "three,two");
      assert.ok((scan.result?.report.parseCache.misses ?? 0) >= 1);

      from = scans.length;
      await writeFile(path.join(root, "src/b.ts"), "export function three( {\n");
      scan = await scanWhere(handle, scans, from, async (last) => last.result?.report.status === "failed");
      assert.deepEqual(await functionNames(reader), ["three", "two"], "a failed scan keeps the last graph");

      from = scans.length;
      await rm(path.join(root, "src/b.ts"));
      scan = await scanWhere(handle, scans, from, async () => await names() === "two");
      assert.equal(scan.result?.report.status, "success");

      const scansSoFar = scans.length;
      await sleep(400);
      assert.equal(scans.length, scansSoFar, "writing the store must not trigger another scan");
      await reader.close();
    } finally {
      await handle.close();
    }
  });
});
