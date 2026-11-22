import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { interpretMsbuild } from "./msbuild.js";
import { interpretSolutions } from "./solution.js";
import { emptyCSharpProjectModel, type CSharpProject, type CSharpProjectModel } from "./types.js";

export * from "./types.js";

// Project files larger than this are not read (generated files, dumps).
const MAX_PROJECT_FILE_BYTES = 1_000_000;

export function isCSharpProjectFile(file: string): boolean {
  return /\.csproj$/iu.test(file);
}

export function isCSharpSolutionFile(file: string): boolean {
  return /\.slnx?$/iu.test(file);
}

/** `Directory.Build.props`, `Directory.Packages.props` and the other MSBuild property files (`.props`). */
export function isMsbuildPropsFile(file: string): boolean {
  return /\.props$/iu.test(file);
}

export function isCSharpBuildFile(file: string): boolean {
  return isCSharpProjectFile(file) || isCSharpSolutionFile(file) || isMsbuildPropsFile(file);
}

let cache: { rootPath: string; signature: string; model: CSharpProjectModel } | null = null;

export function clearCSharpProjectModelCache(): void {
  cache = null;
}

// The projects and solutions among `relativeFiles` (every scanned file of the project). Memoized on the latest root and
// a hash of each build file's path and content (the file list is not part of the key: the build files decide it, so
// `unresolved` counts may come from the first caller's list).
export async function readCSharpProjectModel(rootPath: string, relativeFiles: Iterable<string>): Promise<CSharpProjectModel> {
  const files = [...relativeFiles];
  const buildFiles = files.filter(isCSharpBuildFile).sort();
  if (buildFiles.length === 0) return emptyCSharpProjectModel();

  const msbuildTexts = new Map<string, string>();
  const solutionTexts = new Map<string, string>();
  const hash = createHash("sha256");
  for (const file of buildFiles) {
    try {
      const absolute = path.join(rootPath, file);
      if ((await stat(absolute)).size > MAX_PROJECT_FILE_BYTES) continue;
      const text = await readFile(absolute, "utf8");
      (isCSharpSolutionFile(file) ? solutionTexts : msbuildTexts).set(file, text);
      hash.update(`${file}\0${text.length}\0${text}\0`);
    } catch {
      // Unreadable: skipped.
    }
  }
  if (msbuildTexts.size + solutionTexts.size === 0) return emptyCSharpProjectModel();
  const signature = hash.digest("hex");
  if (cache && cache.rootPath === rootPath && cache.signature === signature) return cache.model;

  const set = new Set(files);
  const model = emptyCSharpProjectModel();
  const read = new Set<string>();
  if (msbuildTexts.size > 0) {
    const msbuild = interpretMsbuild({ files: set, texts: msbuildTexts });
    model.projects.push(...msbuild.projects);
    msbuild.files.forEach((f) => read.add(f));
    model.unresolved += msbuild.unresolved;
  }
  if (solutionTexts.size > 0) {
    const solutions = interpretSolutions({ files: set, texts: solutionTexts });
    model.solutions.push(...solutions.solutions);
    solutions.solutions.forEach((solution) => read.add(solution.file));
    model.unresolved += solutions.unresolved;
  }
  for (const solution of model.solutions) {
    for (const file of solution.projects) {
      const project = model.projects.find((candidate) => candidate.file === file);
      if (project && !project.solutions.includes(solution.file)) project.solutions.push(solution.file);
    }
  }
  for (const project of model.projects) project.solutions.sort();
  model.files = [...read].sort();
  cache = { rootPath, signature, model };
  return model;
}

function containedIn(dir: string, file: string): boolean {
  return dir === "." || dir === "" || file === dir || file.startsWith(`${dir}/`);
}

function normalizeRelative(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

// The project a file belongs to: the one with the longest directory containing it.
export function projectOfFile(model: CSharpProjectModel, relativePath: string): CSharpProject | undefined {
  const file = normalizeRelative(relativePath);
  let best: CSharpProject | undefined;
  for (const project of model.projects) {
    if (!containedIn(project.dir, file)) continue;
    if (!best || (project.dir === "." ? 0 : project.dir.length) > (best.dir === "." ? 0 : best.dir.length)) best = project;
  }
  return best;
}

// The project (by its file) plus every project it references, transitively.
export function visibleProjects(model: CSharpProjectModel, projectFile: string): Set<string> {
  const byFile = new Map(model.projects.map((project) => [project.file, project]));
  const seen = new Set<string>([projectFile]);
  const queue = [projectFile];
  while (queue.length > 0) {
    const project = byFile.get(queue.pop()!);
    if (!project) continue;
    for (const reference of project.projectReferences) {
      if (seen.has(reference)) continue;
      seen.add(reference);
      queue.push(reference);
    }
  }
  return seen;
}
