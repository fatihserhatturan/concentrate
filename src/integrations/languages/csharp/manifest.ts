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
  for (const project of [...model.projects].sort((a, b) => a.file.localeCompare(b.file))) {
    if (dirs.has(project.dir)) continue;
    dirs.add(project.dir);
    kept.push(project);
  }
  return kept;
}

async function readPackages({ rootPath, filePaths }: ProjectManifestContext): Promise<DeclaredPackage[]> {
  const model = await readCSharpProjectModel(rootPath, filePaths);
  if (model.projects.length === 0) return [];
  const nameByFile = new Map(model.projects.map((project) => [project.file, project.name]));
  return declaredCSharpProjects(model).map((project) => ({
    dir: project.dir,
    name: project.name,
    version: null,
    isPrivate: false,
    manager: "dotnet",
    metadataFile: path.posix.basename(project.file),
    // Project references are internal (matched by project name); package references name third-party packages, which
    // core ignores unless a scanned project has the same name.
    dependencies: [
      ...project.projectReferences.flatMap((file) => nameByFile.get(file) ?? []).map((name) => ({ name, type: "project" })),
      ...project.packageReferences.map((reference) => ({ name: reference.name, type: "package" })),
    ],
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
