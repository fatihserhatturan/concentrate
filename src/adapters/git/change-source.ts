import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { ChangeSet, ChangeSourceOptions, IChangeSource } from "../../core/contracts/change-source.js";

const run = promisify(execFile);

// Revisions are passed to git as a single argv entry, never through a shell;
// the pattern still rejects option-like and odd values.
const BASE_PATTERN = /^[\w./~^@{}-]+$/;

export function assertValidRevision(base: string): void {
  if (!BASE_PATTERN.test(base) || base.startsWith("-")) {
    throw new Error(`Invalid base revision: ${JSON.stringify(base)}`);
  }
}

/** Reads working-tree changes by shelling out to `git`. */
export class GitChangeSource implements IChangeSource {
  async changes({ scanPath, base }: ChangeSourceOptions): Promise<ChangeSet> {
    assertValidRevision(base);
    const scanRoot = await realpath(scanPath);
    const git = async (gitArgs: string[]) =>
      (await run("git", ["-c", "core.quotePath=false", ...gitArgs], { cwd: scanRoot, maxBuffer: 64 * 1024 * 1024 })).stdout;
    let repoRoot: string;
    try {
      repoRoot = await realpath((await git(["rev-parse", "--show-toplevel"])).trim());
    } catch {
      throw new Error(`${scanRoot} is not inside a git work tree`);
    }
    const [diff, untracked] = await Promise.all([
      git(["-C", repoRoot, "diff", "--unified=0", "--no-color", "--no-ext-diff", base, "--"]).catch((error: unknown) => {
        const stderr = (error as { stderr?: string }).stderr?.trim();
        throw new Error(`git diff against ${base} failed${stderr ? `: ${stderr}` : ""}`);
      }),
      git(["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    return { scanRoot, repoRoot, diff, untracked: untracked.split("\0").filter(Boolean) };
  }
}
