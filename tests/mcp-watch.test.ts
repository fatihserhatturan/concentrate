import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { scanIntoStore } from "../src/adapters/cli/scan.js";
import { startMcpServer } from "./helpers/mcp-stdio.js";

async function createProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-watch-"));
  const projectPath = path.join(root, "project");
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  await writeFile(path.join(projectPath, "package.json"), JSON.stringify({ name: "watch-app" }));
  await writeFile(path.join(projectPath, "src", "a.ts"), "export function alpha() { return 1; }\n");
  await writeFile(path.join(projectPath, "src", "b.ts"), "export function beta() { return 2; }\n");
  const database = path.join(root, "graph");
  return {
    projectPath,
    database,
    scan: () => scanIntoStore(projectPath, {
      database,
      continueOnError: false,
      include: [],
      exclude: [],
      retryLock: true,
      cacheDir: path.join(root, "cache"),
      manifest: path.join(root, "scan-manifest.json"),
    }),
  };
}

const call = async (server: ReturnType<typeof startMcpServer>, name: string, args: Record<string, unknown>) =>
  (await server.request("tools/call", { name, arguments: args })).structuredContent;

describe("mcp freshness and watch", () => {
  it("flags answers that name a file changed since the scan, and only those", async () => {
    const project = await createProject();
    await project.scan();
    const server = startMcpServer(project.database);
    try {
      const fresh = await call(server, "find_definitions", { name: "alpha" });
      assert.equal(fresh.stale, undefined);

      const later = new Date(Date.now() + 5_000);
      await utimes(path.join(project.projectPath, "src", "a.ts"), later, later);

      const stale = await call(server, "find_definitions", { name: "alpha" });
      assert.deepEqual(stale.stale.files, ["src/a.ts"]);
      assert.match(stale.stale.note, /Read them directly/u);

      const other = await call(server, "find_definitions", { name: "beta" });
      assert.equal(other.stale, undefined);
    } finally {
      await server.close();
    }
  });

  it("with --watch scans at start and picks up a change before the next answer", async () => {
    const project = await createProject();
    // No scan: the first call must wait for the start-up scan.
    const server = startMcpServer(project.database, ["--watch", project.projectPath]);
    try {
      const first = await call(server, "find_definitions", { name: "alpha" });
      assert.equal(first.definitions.length, 1);
      assert.equal((await call(server, "find_definitions", { name: "gamma" })).definitions.length, 0);

      await writeFile(path.join(project.projectPath, "src", "c.ts"), "export function gamma() { return 3; }\n");
      // The file event may arrive late; the call waits for what is pending, so retry briefly.
      const deadline = Date.now() + 10_000;
      let found = 0;
      while (found === 0 && Date.now() < deadline) {
        found = (await call(server, "find_definitions", { name: "gamma" })).definitions.length;
        if (found === 0) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(found, 1);
    } finally {
      await server.close();
    }
  });
});
