import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { hookBlock, HOOK_END, HOOK_START, installGitHooks, mergeGitHook, scanShellCommand } from "../src/adapters/cli/init-hooks.js";

describe("git hooks", () => {
  it("quotes the scan command and runs it in the background", () => {
    const command = scanShellCommand({ root: "/p/it's", database: "/p/.concentrate/graph", npx: true, cliPath: "" });
    assert.equal(command, `npx -y concentrate scan '/p/it'\\''s' --database '/p/.concentrate/graph'`);
    assert.match(hookBlock("post-commit", command), /^# >>> concentrate \(managed\) >>>\n\( npx -y concentrate scan .* >\/dev\/null 2>&1 & \)\n# <<< concentrate \(managed\) <<<$/u);
    assert.match(hookBlock("post-checkout", command), /\[ "\$3" = "1" \] \|\| exit 0/u);
  });

  it("adds the block, replaces it in place and keeps the rest of a hook", () => {
    const block = hookBlock("post-commit", "scan");
    assert.equal(mergeGitHook(null, block), `#!/bin/sh\n${block}\n`);
    const existing = "#!/bin/sh\necho mine\n";
    const added = mergeGitHook(existing, block);
    assert.equal(added, `#!/bin/sh\necho mine\n\n${block}\n`);
    const changed = hookBlock("post-commit", "other");
    assert.equal(mergeGitHook(`${added}echo tail\n`, changed), `#!/bin/sh\necho mine\n\n${changed}\necho tail\n`);
    assert.equal(mergeGitHook(added, block), added);
    assert.throws(() => mergeGitHook("#!/usr/bin/env python3\nprint(1)\n", block, "post-commit"), /not a shell script/u);
    assert.ok(block.startsWith(HOOK_START) && block.endsWith(HOOK_END));
  });

  it("installs executable hooks in a repository, and the post-checkout hook only reacts to branch checkouts", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "concentrate-hooks-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const marker = path.join(root, "scanned");
    const written = await installGitHooks(root, `touch ${JSON.stringify(marker)}`);
    assert.deepEqual(written.map((hook) => [hook.name, hook.created]), [["post-commit", true], ["post-checkout", true], ["post-merge", true]]);
    for (const hook of written) assert.ok((statSync(hook.file).mode & 0o111) !== 0, `${hook.name} is executable`);
    assert.equal((await installGitHooks(root, `touch ${JSON.stringify(marker)}`)).every((hook) => !hook.created), true);

    const checkout = written.find((hook) => hook.name === "post-checkout")!.file;
    execFileSync("sh", [checkout, "old", "new", "0"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(marker), false, "a file checkout does not rescan");
    execFileSync("sh", [checkout, "old", "new", "1"]);
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(marker), true, "a branch checkout rescans");
    assert.match(readFileSync(checkout, "utf8"), /^#!\/bin\/sh\n/u);
  });

  it("names a directory that is not a git work tree", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "concentrate-nogit-"));
    writeFileSync(path.join(root, "x"), "");
    await assert.rejects(() => installGitHooks(root, "true"), /not inside a git work tree/u);
  });
});
