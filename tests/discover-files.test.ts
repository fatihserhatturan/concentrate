import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { discoverFiles } from "../src/core/scan/discover-files.js";

describe("discoverFiles", () => {
  it("never walks Concentrate's own .concentrate directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-discover-"));
    try {
      await mkdir(path.join(root, ".concentrate", "cache"), { recursive: true });
      await writeFile(path.join(root, ".concentrate", "cache", "entry.json"), "{}");
      await writeFile(path.join(root, ".concentrate", "scan-manifest.json"), "{}");
      await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
      const found = (await discoverFiles(root)).map((file) => path.relative(root, file));
      assert.deepEqual(found, ["a.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips nested repositories (worktree .git file, clone .git directory) unless included", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-discover-"));
    try {
      await mkdir(path.join(root, "wt"), { recursive: true });
      await writeFile(path.join(root, "wt", ".git"), "gitdir: /elsewhere\n");
      await writeFile(path.join(root, "wt", "copy.ts"), "export const c = 1;\n");
      await mkdir(path.join(root, "clone", ".git"), { recursive: true });
      await writeFile(path.join(root, "clone", "copy.ts"), "export const c = 1;\n");
      await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
      // Without a repository at the root, the clones inside it are the project (a folder of several clones).
      const rel = (files: string[]) => files.map((file) => path.relative(root, file));
      assert.deepEqual(rel(await discoverFiles(root)), ["a.ts", "clone/copy.ts", "wt/copy.ts"]);
      await mkdir(path.join(root, ".git"));
      assert.deepEqual(rel(await discoverFiles(root)), ["a.ts"]);
      assert.deepEqual(rel(await discoverFiles(root, { include: ["**/*.ts", "wt/**"] })), ["a.ts", "wt/copy.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
