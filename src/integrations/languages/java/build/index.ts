import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { interpretGradle } from "./gradle.js";
import { interpretMaven } from "./maven.js";
import { emptyJavaBuildModel, javaModuleKey, type JavaBuildModel, type JavaModule } from "./types.js";

export * from "./types.js";

// Build files larger than this are not read (generated files, dumps).
const MAX_BUILD_FILE_BYTES = 1_000_000;

export function isMavenBuildFile(file: string): boolean {
  return path.posix.basename(file) === "pom.xml";
}

export function isGradleBuildFile(file: string): boolean {
  const name = path.posix.basename(file);
  return name === "settings.gradle" || name === "settings.gradle.kts" || name === "build.gradle" || name === "build.gradle.kts";
}

export function isJavaBuildFile(file: string): boolean {
  return isMavenBuildFile(file) || isGradleBuildFile(file);
}

let cache: { rootPath: string; signature: string; model: JavaBuildModel } | null = null;

export function clearJavaBuildModelCache(): void {
  cache = null;
}

// The modules of the Maven and Gradle build files among `relativeFiles` (every scanned file of
// the project). Memoized on the latest root and a hash of each build file's path and content. The
// scanned file list is not part of the key: the build files decide it, so `unresolved` counts
// (a directory without files, a module path that is not a pom) may come from the first caller's list.
export async function readJavaBuildModel(rootPath: string, relativeFiles: Iterable<string>): Promise<JavaBuildModel> {
  const files = [...relativeFiles];
  const buildFiles = files.filter(isJavaBuildFile).sort();
  if (buildFiles.length === 0) return emptyJavaBuildModel();

  const mavenTexts = new Map<string, string>();
  const gradleTexts = new Map<string, string>();
  const hash = createHash("sha256");
  for (const file of buildFiles) {
    try {
      const absolute = path.join(rootPath, file);
      if ((await stat(absolute)).size > MAX_BUILD_FILE_BYTES) continue;
      const text = await readFile(absolute, "utf8");
      (isMavenBuildFile(file) ? mavenTexts : gradleTexts).set(file, text);
      hash.update(`${file}\0${text.length}\0${text}\0`);
    } catch {
      // Unreadable: skipped.
    }
  }
  if (mavenTexts.size + gradleTexts.size === 0) return emptyJavaBuildModel();
  const signature = hash.digest("hex");
  if (cache && cache.rootPath === rootPath && cache.signature === signature) return cache.model;

  const set = new Set(files);
  const model = emptyJavaBuildModel();
  const read = new Set<string>();
  if (mavenTexts.size > 0) {
    const maven = interpretMaven({ files: set, texts: mavenTexts });
    model.modules.push(...maven.modules);
    maven.files.forEach((f) => read.add(f));
    model.unresolved += maven.unresolved;
  }
  if (gradleTexts.size > 0) {
    const gradle = interpretGradle({ files: set, texts: gradleTexts });
    model.modules.push(...gradle.modules);
    gradle.files.forEach((f) => read.add(f));
    model.unresolved += gradle.unresolved;
  }
  model.files = [...read].sort();
  cache = { rootPath, signature, model };
  return model;
}

export function containedIn(dir: string, file: string): boolean {
  return dir === "." || dir === "" || file === dir || file.startsWith(`${dir}/`);
}

function normalizeRelative(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

// The module a file belongs to: the one whose source or test roots contain it (longest root wins),
// else the one with the longest directory containing it. Aggregators lose ties to other modules.
export function moduleOfFile(model: JavaBuildModel, relativePath: string): JavaModule | undefined {
  const file = normalizeRelative(relativePath);
  const better = (a: { length: number; module: JavaModule } | null, length: number, module: JavaModule) =>
    !a || length > a.length || (length === a.length && a.module.aggregator && !module.aggregator);

  let byRoot: { length: number; module: JavaModule } | null = null;
  for (const module of model.modules) {
    for (const root of [...module.sourceRoots, ...module.testSourceRoots]) {
      if (!containedIn(root, file)) continue;
      const length = root === "." ? 0 : root.length;
      if (better(byRoot, length, module)) byRoot = { length, module };
    }
  }
  if (byRoot) return byRoot.module;

  let byDir: { length: number; module: JavaModule } | null = null;
  for (const module of model.modules) {
    if (!containedIn(module.dir, file)) continue;
    const length = module.dir === "." ? 0 : module.dir.length;
    if (better(byDir, length, module)) byDir = { length, module };
  }
  return byDir?.module;
}

// The module itself plus everything it depends on, transitively.
export function visibleModules(model: JavaBuildModel, moduleKey: string): Set<string> {
  const byKey = new Map(model.modules.map((module) => [javaModuleKey(module), module]));
  const seen = new Set<string>([moduleKey]);
  const queue = [moduleKey];
  while (queue.length > 0) {
    const module = byKey.get(queue.pop()!);
    if (!module) continue;
    for (const dependency of module.dependencies) {
      if (seen.has(dependency.module)) continue;
      seen.add(dependency.module);
      queue.push(dependency.module);
    }
  }
  return seen;
}
