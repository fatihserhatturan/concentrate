import path from "node:path";
import type { DeclaredPackage, IProjectManifestReader, ProjectConfigValue, ProjectManifestContext } from "../../../core/contracts/project-manifest.js";
import { discoverFiles } from "../../../core/scan/discover-files.js";
import { readCSharpProjectModel, type CSharpProject, type CSharpProjectModel } from "./project/index.js";

// The ignore rules of the scan that apply to project files (see the Java reader): the scan's defaults plus the
// JS/TS descriptor's.
const SCAN_CONVENTIONS = { ignoredPatterns: ["node_modules", ".next", ".turbo"], ignoredInDirectory: () => [] as string[] };

// The projects that become Package nodes: of several projects in one directory the first by file path is kept (a Package
// is keyed by its directory); the others are not declared.
export function declaredCSharpProjects(model: CSharpProjectModel): CSharpProject[] {
  const kept: CSharpProject[] = [];
  const dirs = new Set<string>();
  for (const project of [...model.projects].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    if (dirs.has(project.dir)) continue;
    dirs.add(project.dir);
    kept.push(project);
  }
  return kept;
}

async function readPackages({ rootPath, filePaths }: ProjectManifestContext): Promise<DeclaredPackage[]> {
  const model = await readCSharpProjectModel(rootPath, filePaths);
  if (model.projects.length === 0) return [];
  const declared = declaredCSharpProjects(model);
  // A ProjectReference becomes an edge only to a declared project whose name is unique among the declared ones (the
  // core matches dependencies by name, so a duplicated name would be a wrong edge). Package references are not manifest
  // dependencies: core drops them, and they are shown as `packageReferences` on the Package node.
  const nameCount = new Map<string, number>();
  for (const project of declared) nameCount.set(project.name, (nameCount.get(project.name) ?? 0) + 1);
  const nameByFile = new Map(declared.filter((project) => nameCount.get(project.name) === 1).map((project) => [project.file, project.name]));
  return declared.map((project) => ({
    dir: project.dir,
    name: project.name,
    version: null,
    isPrivate: false,
    manager: "dotnet",
    metadataFile: path.posix.basename(project.file),
    dependencies: project.projectReferences
      .filter((file) => file !== project.file)
      .flatMap((file) => nameByFile.get(file) ?? [])
      .filter((name) => name !== project.name)
      .map((name) => ({ name, type: "project" })),
  }));
}

// Values of the root-level projects (their expanded properties).
async function readConfig({ rootPath, fileSystem }: ProjectManifestContext): Promise<ProjectConfigValue[]> {
  const rootEntries = await fileSystem.readDirectory(rootPath).catch(() => []);
  if (!rootEntries.some((entry) => entry.isFile && /\.csproj$/u.test(entry.name))) return [];
  const files = (await discoverFiles(rootPath, fileSystem, { conventions: SCAN_CONVENTIONS })).map((file) => path.relative(rootPath, file).split(path.sep).join("/"));
  const model = await readCSharpProjectModel(rootPath, files);
  const values: ProjectConfigValue[] = [];
  for (const project of declaredCSharpProjects(model)) {
    if (project.dir !== ".") continue;
    for (const { key, value } of project.config) values.push({ source: project.file, key, value });
  }
  return values;
}

// One Package per `.csproj` (manager "dotnet"), with ProjectReference dependencies between them.
export const csharpManifestReader: IProjectManifestReader = {
  id: "csharp",
  version: "2",
  readPackages,
  readConfig,
};
