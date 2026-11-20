import path from "node:path";
import type { IFileSystem } from "../../../core/contracts/file-system.js";
import type { DeclaredPackage, IProjectManifestReader, ProjectConfigValue, ProjectManifestContext } from "../../../core/contracts/project-manifest.js";
import { createGlobMatcher, walkFiles } from "../../../core/scan/glob.js";
import { extractWorkspacePatterns, readJsonObject, readPnpmWorkspacePatterns } from "./resolution/package-json.js";

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const commonWorkspacePatterns = ["apps/*", "packages/*", "libs/*", "services/*"];

const configFiles: ReadonlyArray<{ file: string; keys: readonly string[] }> = [
  { file: "package.json", keys: ["name", "version", "type", "main", "module", "types"] },
  {
    file: "tsconfig.json",
    keys: [
      "compilerOptions.target",
      "compilerOptions.module",
      "compilerOptions.baseUrl",
      "compilerOptions.outDir",
      "compilerOptions.rootDir",
    ],
  },
  { file: "jsconfig.json", keys: ["compilerOptions.baseUrl", "compilerOptions.checkJs"] },
];

/** `package.json` paths for one workspace pattern such as `packages/*`, skipping `node_modules`. */
export async function findWorkspacePackageJsons(
  rootPath: string,
  workspacePattern: string,
  fileSystem: Pick<IFileSystem, "readDirectory" | "stat">,
): Promise<string[]> {
  if (workspacePattern.startsWith("!")) return [];
  const pattern = workspacePattern.endsWith("package.json")
    ? workspacePattern
    : path.posix.join(workspacePattern, "package.json");
  const matcher = createGlobMatcher(pattern);

  return walkFiles(rootPath, fileSystem, {
    start: [matcher.base],
    accept: (relativePath, isDirectory) => isDirectory
      ? path.posix.basename(relativePath) !== "node_modules" && matcher.mayContain(relativePath)
      : matcher.matches(relativePath),
  });
}

// npm, yarn and pnpm: the root `package.json` and the packages its `workspaces`
// (or `pnpm-workspace.yaml`) name, `package.json` / `tsconfig.json` / `jsconfig.json` values.
export const jsTsManifestReader: IProjectManifestReader = {
  id: "js-ts",
  readPackages: readJsTsPackages,
  readConfig: readJsTsConfig,
};

async function readJsTsPackages({ rootPath, fileSystem, warn }: ProjectManifestContext): Promise<DeclaredPackage[]> {
  const rootPackage = await readJsonObject(path.join(rootPath, "package.json"), warn);
  const workspacePatterns = [
    ...extractWorkspacePatterns(rootPackage),
    ...await readPnpmWorkspacePatterns(rootPath, warn),
  ];

  const effectivePatterns = workspacePatterns.length > 0 ? workspacePatterns : commonWorkspacePatterns;
  const packageJsonPaths = new Set<string>();
  if (rootPackage) packageJsonPaths.add("package.json");

  for (const pattern of effectivePatterns) {
    for (const packageJsonPath of await findWorkspacePackageJsons(rootPath, pattern, fileSystem)) {
      packageJsonPaths.add(packageJsonPath);
    }
  }

  const packages: DeclaredPackage[] = [];
  for (const packageJsonPath of [...packageJsonPaths].sort()) {
    const parsed = await readJsonObject(path.join(rootPath, packageJsonPath), warn);
    if (!parsed) continue;
    packages.push({
      dir: toPosix(path.dirname(packageJsonPath)),
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
      isPrivate: parsed.private === true,
      manager: typeof parsed.packageManager === "string" ? parsed.packageManager : null,
      dependencies: readPackageDependencies(parsed),
      metadataFile: "package.json",
    });
  }
  return packages;
}

async function readJsTsConfig({ rootPath, warn }: ProjectManifestContext): Promise<ProjectConfigValue[]> {
  const values: ProjectConfigValue[] = [];
  for (const { file, keys } of configFiles) {
    const parsed = await readJsonObject(path.join(rootPath, file), warn);
    if (!parsed) continue;
    for (const key of keys) {
      const value = getPathValue(parsed, key);
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        values.push({ source: file, key, value });
      }
    }
  }
  return values;
}

function readPackageDependencies(parsed: Record<string, unknown>): Array<{ name: string; type: string }> {
  const dependencies: Array<{ name: string; type: string }> = [];
  for (const field of dependencyFields) {
    const value = parsed[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const name of Object.keys(value)) dependencies.push({ name, type: field });
  }
  return dependencies;
}

function getPathValue(value: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce((current: unknown, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function toPosix(value: string): string {
  if (!value || value === ".") return ".";
  return value.split(path.sep).join(path.posix.sep);
}
