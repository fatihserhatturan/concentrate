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
});
