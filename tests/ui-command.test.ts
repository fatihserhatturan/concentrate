import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { installSteps, runUiAdapter, uiState } from "../src/adapters/cli/ui.js";
import { parseCommandArgs } from "../src/adapters/cli/args.js";
import { program } from "../src/program.js";

describe("concentrate ui", () => {
  it("tells apart a missing, an uninstalled and an installed ui/ folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-state-"));
    try {
      const ui = path.join(dir, "ui");
      assert.equal(uiState(ui), "missing");
      await mkdir(ui);
      await writeFile(path.join(ui, "package.json"), "{}");
      assert.equal(uiState(ui), "not-installed");
      await mkdir(path.join(ui, "node_modules"));
      assert.equal(uiState(ui), "ready");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints the install steps and fails when the UI is not installed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-steps-"));
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => { errors.push(String(message)); };
    try {
      const ui = path.join(dir, "ui");
      await mkdir(ui);
      await writeFile(path.join(ui, "package.json"), "{}");
      assert.equal(await runUiAdapter({ open: false }, ui), 1);
      assert.match(errors.join("\n"), /npm install/);
      assert.match(installSteps(ui, "not-installed"), new RegExp(`cd ${ui.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.equal(await runUiAdapter({ open: false }, path.join(dir, "nowhere")), 1);
      assert.match(errors.join("\n"), /not part of this installation/);
    } finally {
      console.error = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a command of the program with --port and --no-open", () => {
    const command = program.commands.find((candidate) => candidate.name === "ui");
    assert.ok(command);
    const parsed = parseCommandArgs(command, ["--port", "4000", "--no-open"]);
    assert.equal(parsed.options.port, 4000);
    assert.equal(parsed.options.open, false);
  });
});
