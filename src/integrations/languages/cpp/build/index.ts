import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { interpretCMake } from "./cmake.js";
import { interpretMakefiles } from "./make.js";
import { emptyBuildModel, type BuildModel, type BuildTarget } from "./types.js";

export * from "./types.js";
export { isCppHeaderFile, isCppSourceFile } from "./cmake.js";

// Build files larger than this are not read (generated files, dumps).
const MAX_BUILD_FILE_BYTES = 1_000_000;

export function isCMakeFile(file: string): boolean {
  const name = path.posix.basename(file);
  return name === "CMakeLists.txt" || name.endsWith(".cmake");
}

export function isMakefile(file: string): boolean {
  const name = path.posix.basename(file);
  return name === "Makefile" || name === "makefile" || name === "GNUmakefile" || name.endsWith(".mk");
}

async function readBuildTexts(rootPath: string, files: readonly string[], accept: (file: string) => boolean): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const file of files) {
    if (!accept(file)) continue;
    try {
      const absolute = path.join(rootPath, file);
      if ((await stat(absolute)).size > MAX_BUILD_FILE_BYTES) continue;
      texts.set(file, await readFile(absolute, "utf8"));
    } catch {
      // Unreadable: skipped.
    }
  }
  return texts;
}

// The targets of the CMake files and Makefiles among `relativeFiles` (every
// scanned file of the project), with the include directories and definitions
// each source file is compiled with.
export async function readBuildModel(rootPath: string, relativeFiles: Iterable<string>): Promise<BuildModel> {
  const files = [...relativeFiles];
  const set = new Set(files);
  const cmakeTexts = await readBuildTexts(rootPath, files, isCMakeFile);
  const makeTexts = await readBuildTexts(rootPath, files, isMakefile);
  const model = emptyBuildModel();
  if (cmakeTexts.size === 0 && makeTexts.size === 0) return model;

  if (cmakeTexts.size > 0) {
    const cmake = interpretCMake({ rootPath, files: set, texts: cmakeTexts });
    model.targets.push(...cmake.targets);
    model.files.push(...cmake.files);
    model.unresolved += cmake.unresolved;
    addEffective(model, cmake.targets);
  }
  if (makeTexts.size > 0) {
    const make = interpretMakefiles({ files: set, texts: makeTexts });
    model.targets.push(...make.targets);
    model.files.push(...make.files);
    model.unresolved += make.unresolved;
    for (const [file, dirs] of make.includeDirsByFile) merge(model.includeDirsByFile, file, dirs);
    for (const [file, definitions] of make.definitionsByFile) {
      const known = model.definitionsByFile.get(file) ?? new Map<string, string>();
      for (const [name, value] of definitions) if (!known.has(name)) known.set(name, value);
      model.definitionsByFile.set(file, known);
    }
  }
  model.files.sort();
  return model;
}

function merge(map: Map<string, string[]>, file: string, dirs: string[]): void {
  const known = map.get(file);
  if (!known) map.set(file, [...dirs]);
  else for (const dir of dirs) if (!known.includes(dir)) known.push(dir);
}

// What a target's sources are compiled with: its own directories and
// definitions, then what the targets it links to export (their PUBLIC and
// INTERFACE ones, and those of the targets they link to publicly).
function addEffective(model: BuildModel, targets: BuildTarget[]): void {
  const byName = new Map(targets.map((target) => [`cmake:${target.name}`, target]));
  for (const target of targets) {
    const dirs = [...target.includePrivate];
    const definitions = [...target.definitionsPrivate];
    const seen = new Set<BuildTarget>([target]);
    const collect = (from: BuildTarget, all: boolean) => {
      for (const link of from.links) {
        if (!all && link.visibility === "private") continue;
        const linked = byName.get(link.target);
        if (!linked || seen.has(linked)) continue;
        seen.add(linked);
        for (const dir of linked.includeInterface) if (!dirs.includes(dir)) dirs.push(dir);
        for (const definition of linked.definitionsInterface) if (!definitions.includes(definition)) definitions.push(definition);
        collect(linked, false);
      }
    };
    collect(target, true);
    const parsed = new Map<string, string>();
    for (const definition of definitions) {
      const equals = definition.indexOf("=");
      parsed.set(equals === -1 ? definition : definition.slice(0, equals), equals === -1 ? "" : definition.slice(equals + 1));
    }
    for (const source of target.sources) {
      merge(model.includeDirsByFile, source, dirs);
      if (parsed.size === 0) continue;
      const known = model.definitionsByFile.get(source) ?? new Map<string, string>();
      for (const [name, value] of parsed) if (!known.has(name)) known.set(name, value);
      model.definitionsByFile.set(source, known);
    }
  }
}
