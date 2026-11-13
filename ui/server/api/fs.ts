import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type FsEntry = { name: string; path: string; isGitRepository: boolean; hasGraph: boolean };
export type FsListing = {
  path: string;
  parent: string | null;
  home: string;
  /** The listed directory itself: is it a git repository, does it have a graph. */
  current: { isGitRepository: boolean; hasGraph: boolean; /** A git repository or a folder with a manifest file: something worth scanning. */ looksLikeProject: boolean };
  entries: FsEntry[];
};

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const MANIFESTS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "CMakeLists.txt", "Makefile", "composer.json", "Gemfile", "deno.json", "tsconfig.json", "concentrate.json"];

async function looksLikeProject(directory: string): Promise<boolean> {
  // The home folder and the filesystem root hold projects; they are not one, even with a stray .git or manifest.
  if (directory === os.homedir() || path.dirname(directory) === directory) return false;
  if (await exists(path.join(directory, ".git"))) return true;
  for (const name of MANIFESTS) if (await exists(path.join(directory, name))) return true;
  return false;
}

/** Lists the sub-directories of a path, hidden ones excluded. */
export async function listDirectories(requested: string | undefined): Promise<FsListing> {
  const target = path.resolve(requested && requested.length > 0 ? requested : os.homedir());
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${target}`);
  const dirents = await readdir(target, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    const full = path.join(target, dirent.name);
    entries.push({
      name: dirent.name,
      path: full,
      isGitRepository: await exists(path.join(full, ".git")),
      hasGraph: await exists(path.join(full, ".concentrate", "graph")),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home: os.homedir(),
    current: { isGitRepository: await exists(path.join(target, ".git")), hasGraph: await exists(path.join(target, ".concentrate", "graph")), looksLikeProject: await looksLikeProject(target) },
    entries,
  };
}
