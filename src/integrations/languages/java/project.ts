import path from "node:path";
import type { DeclaredPackage, IProjectManifestReader, ProjectConfigValue, ProjectManifestContext } from "../../../core/contracts/project-manifest.js";
import { walkFiles } from "../../../core/scan/glob.js";
import { javaModuleKey, readJavaBuildModel, type JavaBuildModel, type JavaModule } from "./build/index.js";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".gradle", ".idea", "target", "build", "out"]);

function containedIn(dir: string, file: string): boolean {
  return dir === "." || dir === "" || file === dir || file.startsWith(`${dir}/`);
}

// The modules that become Package nodes: a module with no build file of its own (it is only named by
// a settings file) and no scanned file in its source roots (Gradle's intermediate `:libs`) is dropped,
// and of several modules in one directory (a Maven aggregator and a Gradle root) the first is kept.
export function declaredJavaModules(model: JavaBuildModel, files: readonly string[]): JavaModule[] {
  const kept: JavaModule[] = [];
  const dirs = new Set<string>();
  for (const module of model.modules) {
    if (dirs.has(module.dir)) continue;
    const ownBuildFile = !path.posix.basename(module.file).startsWith("settings.gradle");
    const hasSource = [...module.sourceRoots, ...module.testSourceRoots].some((root) => files.some((file) => containedIn(root, file)));
    if (!ownBuildFile && !hasSource) continue;
    dirs.add(module.dir);
    kept.push(module);
  }
  return kept;
}

async function readPackages({ rootPath, filePaths }: ProjectManifestContext): Promise<DeclaredPackage[]> {
  const model = await readJavaBuildModel(rootPath, filePaths);
  if (model.modules.length === 0) return [];
  const nameByKey = new Map(model.modules.map((module) => [javaModuleKey(module), module.name]));
  return declaredJavaModules(model, filePaths).map((module) => ({
    dir: module.dir,
    name: module.name,
    version: module.version,
    isPrivate: false,
    manager: module.system,
    metadataFile: path.posix.basename(module.file),
    dependencies: module.dependencies.map((dependency) => ({ name: nameByKey.get(dependency.module) ?? dependency.module, type: dependency.scope })),
  }));
}

// Values of the root modules' build files (Maven properties, Java release / source / target).
async function readConfig({ rootPath, fileSystem }: ProjectManifestContext): Promise<ProjectConfigValue[]> {
  // Only a root build file makes this reader's output; skip the walk otherwise.
  const rootEntries = await fileSystem.readDirectory(rootPath).catch(() => []);
  if (!rootEntries.some((entry) => entry.isFile && /^(pom\.xml|settings\.gradle|settings\.gradle\.kts|build\.gradle|build\.gradle\.kts)$/u.test(entry.name))) return [];
  const files = await walkFiles(rootPath, fileSystem, {
    accept: (relativePath, isDirectory) => !isDirectory || (!SKIPPED_DIRECTORIES.has(path.posix.basename(relativePath)) && !path.posix.basename(relativePath).startsWith(".")),
  });
  const model = await readJavaBuildModel(rootPath, files);
  const values: ProjectConfigValue[] = [];
  for (const module of declaredJavaModules(model, files)) {
    if (module.dir !== ".") continue;
    for (const { key, value } of module.config) values.push({ source: module.file, key, value });
  }
  return values;
}

// Maven and Gradle modules, from `pom.xml`, `settings.gradle(.kts)` and `build.gradle(.kts)`.
export const javaManifestReader: IProjectManifestReader = {
  id: "java",
  version: "1",
  readPackages,
  readConfig,
};
