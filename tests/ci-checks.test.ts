import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCommandArgs } from "../src/adapters/cli/args.js";
import { scanIntoStore } from "../src/adapters/cli/scan.js";
import { runCyclesAdapter, runUnusedAdapter } from "../src/adapters/cli/index.js";
import { program } from "../src/program.js";

async function scanned(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-ci-"));
  const project = path.join(root, "project");
  for (const [file, text] of Object.entries({ "package.json": JSON.stringify({ name: "ci-app" }), ...files })) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), text);
  }
  const database = path.join(root, "graph");
  await scanIntoStore(project, { database, continueOnError: false, include: [], exclude: [], retryLock: true, cacheDir: path.join(root, "cache"), manifest: path.join(root, "m.json") });
  return database;
}

async function captured<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => { lines.push(parts.join(" ")); };
  try {
    return { result: await run(), output: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

describe("CI checks", () => {
  it("cycles exits 1 on a runtime cycle, honors --max and ignores type-only cycles", async () => {
    const cyclic = await scanned({
      "src/a.ts": "import { b } from './b';\nexport function a() { return b(); }\n",
      "src/b.ts": "import { a } from './a';\nexport function b() { return a(); }\n",
    });
    const found = await captured(() => runCyclesAdapter({ database: cyclic }));
    assert.equal(found.result.exitCode, 1);
    assert.match(found.output, /2 files: src\/[ab]\.ts -> src\/[ab]\.ts -> src\/[ab]\.ts/u);
    assert.equal((await captured(() => runCyclesAdapter({ database: cyclic, max: 1 }))).result.exitCode, 0);
    const json = JSON.parse((await captured(() => runCyclesAdapter({ database: cyclic, json: true }))).output);
    assert.equal(json.count, 1);

    const typeOnly = await scanned({
      "src/a.ts": "import type { B } from './b';\nexport interface A { b?: B }\n",
      "src/b.ts": "import type { A } from './a';\nexport interface B { a?: A }\n",
    });
    assert.equal((await captured(() => runCyclesAdapter({ database: typeOnly }))).result.exitCode, 0);
    assert.equal((await captured(() => runCyclesAdapter({ database: typeOnly, includeTypeOnly: true }))).result.exitCode, 1);

    const clean = await scanned({ "src/a.ts": "export const a = 1;\n" });
    const none = await captured(() => runCyclesAdapter({ database: clean }));
    assert.equal(none.result.exitCode, 0);
    assert.match(none.output, /No import cycles/u);
  });

  it("unused exits 1 on a candidate and 0 within --max", async () => {
    const database = await scanned({
      "src/used.ts": "export function used() { return 1; }\nexport function lonely() { return 2; }\n",
      "src/main.ts": "import { used } from './used';\nexport function main() { return used(); }\n",
    });
    const result = await captured(() => runUnusedAdapter({ database }));
    assert.equal(result.result.exitCode, 1);
    assert.match(result.output, /src\/used\.ts:\d+ function lonely/u);
    assert.equal((await captured(() => runUnusedAdapter({ database, max: 10 }))).result.exitCode, 0);
  });

  it("parses the commands' options", () => {
    const cycles = program.commands.find((command) => command.name === "cycles")!;
    assert.deepEqual(parseCommandArgs(cycles, ["--max", "2", "--include-type-only"]).options, { database: ".concentrate/graph", max: 2, includeTypeOnly: true, json: false });
  });
});
