import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Git hooks that rescan after the working tree moves: post-commit,
// post-checkout (branch switches only) and post-merge. Each rescan starts in
// the background so the git command does not wait for it, and uses the parse
// cache, so only changed files are parsed. The managed block sits between
// markers; the rest of an existing hook is kept, and a rerun replaces the block.

export const HOOK_NAMES = ["post-commit", "post-checkout", "post-merge"] as const;
export type GitHookName = (typeof HOOK_NAMES)[number];

export const HOOK_START = "# >>> concentrate (managed) >>>";
export const HOOK_END = "# <<< concentrate (managed) <<<";

const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;

// The block of one hook. `scanCommand` is the shell words that run the scan.
export function hookBlock(name: GitHookName, scanCommand: string): string {
  // post-checkout gets (old, new, flag); flag 1 is a branch checkout, 0 a file checkout.
  const guard = name === "post-checkout" ? `[ "$3" = "1" ] || exit 0\n` : "";
  return `${HOOK_START}\n${guard}( ${scanCommand} >/dev/null 2>&1 & )\n${HOOK_END}`;
}

export function scanShellCommand(options: { root: string; database: string; npx: boolean; cliPath: string }): string {
  const scan = ["scan", quote(options.root), "--database", quote(options.database)].join(" ");
  return options.npx ? `npx -y concentrate ${scan}` : `${quote(process.execPath)} ${quote(options.cliPath)} ${scan}`;
}

// The hook file with the managed block added or replaced. A hook that is
// not a shell script (another interpreter in its first line) is refused.
export function mergeGitHook(existing: string | null, block: string, file = "hook"): string {
  if (existing === null || existing.trim() === "") return `#!/bin/sh\n${block}\n`;
  const shebang = /^#!(.*)$/mu.exec(existing.split("\n")[0] ?? "");
  if (shebang && !/\b(?:ba|z|da|k)?sh\b/u.test(shebang[1]!)) throw new Error(`${file} is not a shell script (${shebang[0]}); add the scan to it by hand`);
  const start = existing.indexOf(HOOK_START);
  const end = start === -1 ? -1 : existing.indexOf(HOOK_END, start);
  if (start !== -1 && end !== -1) return `${existing.slice(0, start)}${block}${existing.slice(end + HOOK_END.length)}`;
  const body = existing.replace(/\s+$/u, "");
  // The block's `exit 0` guard must not cut the rest of an existing hook short, so it runs last.
  return `${body}\n\n${block}\n`;
}

// The hooks directory git uses for `root`: .git/hooks, a worktree's shared
// one, or core.hooksPath.
export async function gitHooksDirectory(root: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", root, "rev-parse", "--git-path", "hooks"]);
    return path.resolve(root, stdout.trim());
  } catch {
    throw new Error(`${root} is not inside a git work tree; --hooks needs one`);
  }
}

export async function installGitHooks(root: string, scanCommand: string): Promise<Array<{ name: GitHookName; file: string; created: boolean }>> {
  const directory = await gitHooksDirectory(root);
  await mkdir(directory, { recursive: true });
  const written = [];
  for (const name of HOOK_NAMES) {
    const file = path.join(directory, name);
    const existing = await readFile(file, "utf8").catch(() => null);
    await writeFile(file, mergeGitHook(existing, hookBlock(name, scanCommand), file));
    await chmod(file, 0o755);
    written.push({ name, file, created: existing === null });
  }
  return written;
}
