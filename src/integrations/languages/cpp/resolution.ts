import { readFile } from "node:fs/promises";
import path from "node:path";
import { readBuildModel } from "./build/index.js";

// Where `#include` looks beyond the including file's directory: the `-I`,
// `-iquote`, `-isystem` and `-idirafter` directories of the project's
// `compile_commands.json`, of its CMake files (`include_directories`,
// `target_include_directories`, through the targets a target links to) and of
// its Makefile compile rules. The `-D` / `target_compile_definitions` values
// resolve a computed include (`#include CONFIG_HEADER`).
export type CppIncludeConfig = {
  // Include directories (relative to the scan root) per source file.
  dirsByFile: Map<string, string[]>;
  // The union of them: what a header (which has no compile command) sees.
  allDirs: string[];
  // Definitions per source file (`-DNAME=value`), and the union of them for headers.
  definitionsByFile: Map<string, Map<string, string>>;
  allDefinitions: Map<string, string>;
  // The compile_commands.json read, relative to the scan root.
  source: string | null;
  // The CMake files and Makefiles read.
  buildFiles: string[];
};

const compileCommandsLocations = ["compile_commands.json", "build/compile_commands.json", "out/compile_commands.json", "cmake-build-debug/compile_commands.json", "cmake-build-release/compile_commands.json"];

export async function readCppIncludeConfig(rootPath: string, relativeFiles: Iterable<string> = []): Promise<CppIncludeConfig> {
  const config = await readCompileCommands(rootPath);
  const model = await readBuildModel(rootPath, relativeFiles);
  for (const [file, dirs] of model.includeDirsByFile) {
    const known = config.dirsByFile.get(file);
    config.dirsByFile.set(file, known ? [...known, ...dirs.filter((dir) => !known.includes(dir))] : dirs);
  }
  for (const [file, definitions] of model.definitionsByFile) {
    const known = config.definitionsByFile.get(file) ?? new Map<string, string>();
    for (const [name, value] of definitions) if (!known.has(name)) known.set(name, value);
    config.definitionsByFile.set(file, known);
  }
  config.buildFiles = model.files;
  const all = new Set<string>(config.allDirs);
  for (const dirs of config.dirsByFile.values()) for (const dir of dirs) all.add(dir);
  config.allDirs = [...all];
  for (const definitions of config.definitionsByFile.values()) for (const [name, value] of definitions) if (!config.allDefinitions.has(name)) config.allDefinitions.set(name, value);
  return config;
}

async function readCompileCommands(rootPath: string): Promise<CppIncludeConfig> {
  const empty: CppIncludeConfig = { dirsByFile: new Map(), allDirs: [], definitionsByFile: new Map(), allDefinitions: new Map(), source: null, buildFiles: [] };
  for (const location of compileCommandsLocations) {
    let entries: unknown;
    try {
      entries = JSON.parse(await readFile(path.join(rootPath, location), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    const dirsByFile = new Map<string, string[]>();
    const definitionsByFile = new Map<string, Map<string, string>>();
    const all = new Set<string>();
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (typeof entry?.file !== "string") continue;
      const directory = typeof entry.directory === "string" ? entry.directory : rootPath;
      const args = Array.isArray(entry.arguments) ? entry.arguments.map(String) : typeof entry.command === "string" ? splitCommand(entry.command) : [];
      const dirs: string[] = [];
      for (const dir of includeDirectories(args)) {
        const relative = relativeToRoot(rootPath, path.resolve(rootPath, directory, dir));
        if (relative !== null && !dirs.includes(relative)) dirs.push(relative);
      }
      const file = relativeToRoot(rootPath, path.resolve(rootPath, directory, entry.file));
      if (file === null) continue;
      dirsByFile.set(file, dirs);
      const definitions = definitionsOf(args);
      if (definitions.size > 0) definitionsByFile.set(file, definitions);
      for (const dir of dirs) all.add(dir);
    }
    return { ...empty, dirsByFile, allDirs: [...all], definitionsByFile, source: location };
  }
  return empty;
}

function relativeToRoot(rootPath: string, absolute: string): string | null {
  const relative = path.relative(rootPath, absolute).split(path.sep).join("/");
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative;
}

// A shell command line as its words (quotes group, a backslash escapes).
function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === "\"" && index + 1 < command.length) current += command[++index];
      else current += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < command.length) {
      current += command[++index];
      started = true;
    } else if (/\s/u.test(char)) {
      if (started || current) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started || current) words.push(current);
  return words;
}

const separate = new Set(["-I", "-iquote", "-isystem", "-idirafter", "/I"]);

function includeDirectories(args: string[]): string[] {
  const dirs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (separate.has(arg)) {
      const next = args[index + 1];
      if (next) dirs.push(next);
      index += 1;
      continue;
    }
    const match = /^(?:-I|-iquote|-isystem|-idirafter|\/I)(.+)$/u.exec(arg);
    if (match) dirs.push(match[1]!);
  }
  return dirs;
}

// `-DNAME`, `-DNAME=value` and `-D NAME=value` of a compile command.
function definitionsOf(args: string[]): Map<string, string> {
  const definitions = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const text = arg === "-D" ? args[++index] : arg.startsWith("-D") ? arg.slice(2) : undefined;
    if (!text) continue;
    const equals = text.indexOf("=");
    definitions.set(equals === -1 ? text : text.slice(0, equals), equals === -1 ? "" : text.slice(equals + 1));
  }
  return definitions;
}

export type CppFileIndex = {
  files: ReadonlySet<string>;
  // Files by the last path segment, for the unique-suffix fallback.
  byBasename: ReadonlyMap<string, readonly string[]>;
};

export function createCppFileIndex(files: Iterable<string>): CppFileIndex {
  const set = new Set<string>();
  const byBasename = new Map<string, string[]>();
  for (const file of files) {
    set.add(file);
    const base = path.posix.basename(file);
    const list = byBasename.get(base) ?? [];
    list.push(file);
    byBasename.set(base, list);
  }
  return { files: set, byBasename };
}

// The scanned file an `#include` names, or null (an external header). A
// quoted include is tried relative to the including file, then through the
// include directories; an angle include only through them. A quoted include
// no directory finds still resolves when exactly one scanned file ends with
// its path (a project with no compile_commands.json).
export function resolveCppInclude(
  source: string,
  isSystem: boolean,
  importerFile: string,
  index: CppFileIndex,
  config: CppIncludeConfig,
): string | null {
  // `#include CONFIG_HEADER` with `-DCONFIG_HEADER="cfg.h"` (or `<cfg.h>`).
  if (/^[A-Za-z_]\w*$/u.test(source)) {
    const value = (config.definitionsByFile.get(importerFile) ?? config.allDefinitions).get(source);
    const written = value === undefined ? null : /^\\?"(.+?)\\?"$/u.exec(value) ?? /^<(.+)>$/u.exec(value);
    if (!written) return null;
    return resolveCppInclude(written[1]!, value!.startsWith("<"), importerFile, index, config);
  }
  const candidates: string[] = [];
  if (!isSystem) candidates.push(path.posix.join(path.posix.dirname(importerFile), source));
  for (const dir of config.dirsByFile.get(importerFile) ?? config.allDirs) candidates.push(path.posix.join(dir, source));
  for (const candidate of candidates) {
    const normalized = path.posix.normalize(candidate);
    if (!normalized.startsWith("..") && index.files.has(normalized)) return normalized;
  }
  if (isSystem) return null;
  const suffix = path.posix.normalize(source);
  if (suffix.startsWith("..")) return null;
  const matches = (index.byBasename.get(path.posix.basename(suffix)) ?? []).filter((file) => file === suffix || file.endsWith(`/${suffix}`));
  return matches.length === 1 ? matches[0]! : null;
}
