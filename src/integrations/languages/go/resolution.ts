import { readFile } from "node:fs/promises";
import path from "node:path";

// A module path and the directory (relative to the scan root, "." for the
// root) its packages live in.
export type GoModule = { path: string; dir: string };

export type GoResolutionConfig = {
  // Longest path first, so `a/b` wins over `a` for `a/b/c`.
  modules: GoModule[];
};

// The modules of a scan: every `go.mod` above a Go file (nested modules
// included), the modules a root `go.work` uses, and local `replace`
// directives (`replace example.com/x => ../x`), which point a module path at
// a directory of the scan.
export async function readGoResolutionConfig(rootPath: string, relativePaths: Iterable<string> = []): Promise<GoResolutionConfig> {
  const moduleDirs = new Set<string>();
  const checked = new Set<string>();
  for (const relativePath of relativePaths) {
    if (!relativePath.endsWith(".go")) continue;
    let dir = path.posix.dirname(relativePath);
    while (!checked.has(dir)) {
      checked.add(dir);
      if (await readText(path.join(rootPath, dir, "go.mod")) !== null) {
        moduleDirs.add(dir);
        break;
      }
      if (dir === ".") break;
      dir = path.posix.dirname(dir);
    }
  }
  if (moduleDirs.size === 0 && await readText(path.join(rootPath, "go.mod")) !== null) moduleDirs.add(".");

  const work = await readText(path.join(rootPath, "go.work"));
  for (const dir of work === null ? [] : directiveArguments(work, "use")) {
    moduleDirs.add(path.posix.normalize(dir));
  }

  const modules = new Map<string, string>();
  const replaced = new Map<string, string>();
  for (const dir of moduleDirs) {
    const raw = await readText(path.join(rootPath, dir, "go.mod"));
    if (raw === null) continue;
    const name = /^module\s+"?([^\s"]+)"?/mu.exec(raw)?.[1];
    if (name && !modules.has(name)) modules.set(name, dir);
    for (const [from, to] of replaceDirectives(raw)) replaced.set(from, path.posix.normalize(path.posix.join(dir, to)));
  }
  for (const [from, to] of work === null ? [] : replaceDirectives(work)) replaced.set(from, path.posix.normalize(to));
  for (const [from, dir] of replaced) {
    if (!dir.startsWith("..")) modules.set(from, dir);
  }

  return {
    modules: [...modules].map(([modulePath, dir]) => ({ path: modulePath, dir }))
      .sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path)),
  };
}

// The directory an import path names, if a module of the scan holds it.
export function goPackageDirectory(source: string, goConfig: GoResolutionConfig): string | null {
  for (const module of goConfig.modules) {
    if (source !== module.path && !source.startsWith(`${module.path}/`)) continue;
    const rest = source.slice(module.path.length + 1);
    return path.posix.normalize(path.posix.join(module.dir, rest));
  }
  return null;
}

// A Go import names a package, which is every file of one directory: the
// files it resolves to, tests (`_test.go`) left out.
export function resolveGoImport(
  source: string,
  goFilesByDirectory: Map<string, string[]>,
  goConfig: GoResolutionConfig,
): string[] {
  const dir = goPackageDirectory(source, goConfig);
  if (dir === null) return [];
  return (goFilesByDirectory.get(dir) ?? []).filter((fileId) => !fileId.endsWith("_test.go"));
}

export function indexGoFilesByDirectory(relativePaths: Iterable<[string, string]>): Map<string, string[]> {
  const byDirectory = new Map<string, string[]>();
  for (const [relativePath, fileId] of relativePaths) {
    if (!relativePath.endsWith(".go")) continue;
    const dir = path.posix.dirname(relativePath);
    byDirectory.set(dir, [...byDirectory.get(dir) ?? [], fileId]);
  }
  for (const files of byDirectory.values()) files.sort();
  return byDirectory;
}

// Arguments of a directive, single (`use ./a`) or in a block (`use ( ./a )`),
// comments dropped.
function directiveArguments(raw: string, directive: string): string[] {
  const lines = raw.split("\n").map((line) => line.replace(/\/\/.*$/u, "").trim());
  const values: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      if (line === ")") inBlock = false;
      else if (line !== "") values.push(line);
      continue;
    }
    if (line === `${directive} (`) inBlock = true;
    else if (line.startsWith(`${directive} `)) values.push(line.slice(directive.length + 1).trim());
  }
  return values;
}

// `replace from [v] => to [v]` where `to` is a local directory.
function replaceDirectives(raw: string): Array<[string, string]> {
  const replaces: Array<[string, string]> = [];
  for (const value of directiveArguments(raw, "replace")) {
    const [left, right] = value.split("=>").map((side) => side.trim().split(/\s+/u));
    const from = left?.[0];
    const to = right?.[0];
    if (from && to && (to.startsWith("./") || to.startsWith("../") || to === ".")) replaces.push([from, to]);
  }
  return replaces;
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw error;
  }
}
