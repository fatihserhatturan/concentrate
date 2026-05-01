import path from "node:path";
import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { extractPackageExportTargets } from "./package-json-exports.js";

export type JsTsPackageJsonResolutionConfig = {
  name: string | null;
  main: string | null;
  types: string | null;
  exports: unknown;
};

export type JsTsWorkspacePackageResolutionConfig = JsTsPackageJsonResolutionConfig & {
  rootRelativePath: string;
};

export type ConfigWarningSink = (filePath: string, error: unknown) => void;

export async function readJsTsPackageJsonResolutionConfig(
  rootPath: string,
  onWarning?: ConfigWarningSink,
): Promise<JsTsPackageJsonResolutionConfig | null> {
  const packageJsonPath = path.join(rootPath, "package.json");
  let rawPackageJson: string;
  try {
    rawPackageJson = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }

  let parsed: {
    name?: unknown;
    main?: unknown;
    types?: unknown;
    typings?: unknown;
    exports?: unknown;
  };
  try {
    parsed = JSON.parse(rawPackageJson) as {
      name?: unknown;
      main?: unknown;
      types?: unknown;
      typings?: unknown;
      exports?: unknown;
    };
  } catch (error) {
    onWarning?.(packageJsonPath, error);
    return null;
  }

  const types = typeof parsed.types === "string"
    ? parsed.types
    : typeof parsed.typings === "string"
      ? parsed.typings
      : null;

  return {
    name: typeof parsed.name === "string" ? parsed.name : null,
    main: typeof parsed.main === "string" ? parsed.main : null,
    types,
    exports: parsed.exports,
  };
}

export async function readJsTsWorkspacePackageResolutionConfigs(
  rootPath: string,
  onWarning?: ConfigWarningSink,
): Promise<JsTsWorkspacePackageResolutionConfig[]> {
  const rootPackageJsonPath = path.join(rootPath, "package.json");
  const rootPackageJson = await readJsonObject(rootPackageJsonPath, onWarning);
  const patterns = [
    ...extractWorkspacePatterns(rootPackageJson),
    ...await readPnpmWorkspacePatterns(rootPath, onWarning),
  ];
  const effectivePatterns = patterns.length > 0 ? patterns : ["apps/*", "packages/*", "libs/*", "services/*"];
  const packageJsonPaths = new Set<string>();

  for (const pattern of effectivePatterns) {
    const packageJsonPattern = pattern.endsWith("package.json")
      ? pattern
      : path.posix.join(pattern, "package.json");
    for (const packageJsonPath of await fg(packageJsonPattern, {
      cwd: rootPath,
      dot: true,
      onlyFiles: true,
      absolute: false,
      ignore: ["**/node_modules/**"],
    })) {
      packageJsonPaths.add(packageJsonPath);
    }
  }

  const packages: JsTsWorkspacePackageResolutionConfig[] = [];
  for (const packageJsonPath of [...packageJsonPaths].sort()) {
    const parsed = await readJsonObject(path.join(rootPath, packageJsonPath), onWarning);
    if (!parsed) continue;

    const config = packageJsonConfigFromObject(parsed);
    if (!config.name) continue;

    packages.push({
      ...config,
      rootRelativePath: toPosix(path.dirname(packageJsonPath)),
    });
  }

  return packages;
}

export function createJsTsPackageImportBasePaths(
  source: string,
  packageJson: JsTsPackageJsonResolutionConfig | null,
): string[] {
  if (!packageJson?.name) {
    return [];
  }

  if (source === packageJson.name) {
    return [
      ...extractPackageExportTargets(packageJson.exports, "."),
      ...compact([packageJson.types, packageJson.main, "./index"]),
    ].map(normalizePackageTarget);
  }

  const packagePrefix = `${packageJson.name}/`;
  if (!source.startsWith(packagePrefix)) {
    return [];
  }

  const subpath = `./${source.slice(packagePrefix.length)}`;
  return [
    ...extractPackageExportTargets(packageJson.exports, subpath),
    subpath,
  ].map(normalizePackageTarget);
}

export function createJsTsWorkspacePackageImportBasePaths(
  source: string,
  workspacePackages: JsTsWorkspacePackageResolutionConfig[],
): string[] {
  const candidates: string[] = [];

  for (const workspacePackage of workspacePackages) {
    for (const packageTarget of createJsTsPackageImportBasePaths(source, workspacePackage)) {
      candidates.push(path.posix.join(workspacePackage.rootRelativePath, packageTarget));
    }
  }

  return candidates;
}

async function readJsonObject(
  filePath: string,
  onWarning?: ConfigWarningSink,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onWarning?.(filePath, error);
    }
    return null;
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    onWarning?.(filePath, error);
    return null;
  }
}

function packageJsonConfigFromObject(parsed: Record<string, unknown>): JsTsPackageJsonResolutionConfig {
  const types = typeof parsed.types === "string"
    ? parsed.types
    : typeof parsed.typings === "string"
      ? parsed.typings
      : null;

  return {
    name: typeof parsed.name === "string" ? parsed.name : null,
    main: typeof parsed.main === "string" ? parsed.main : null,
    types,
    exports: parsed.exports,
  };
}

function extractWorkspacePatterns(parsed: Record<string, unknown> | null): string[] {
  if (!parsed) return [];

  const workspaces = parsed.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((value): value is string => typeof value === "string");
  }

  if (workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      return packages.filter((value): value is string => typeof value === "string");
    }
  }

  return [];
}

async function readPnpmWorkspacePatterns(rootPath: string, onWarning?: ConfigWarningSink): Promise<string[]> {
  const pnpmWorkspacePath = path.join(rootPath, "pnpm-workspace.yaml");
  let raw: string;
  try {
    raw = await readFile(pnpmWorkspacePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onWarning?.(pnpmWorkspacePath, error);
    }
    return [];
  }

  const patterns: string[] = [];
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "packages:") {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (trimmed.length > 0 && !trimmed.startsWith("-")) break;

    const match = trimmed.match(/^-\s*['"]?([^'"]+)['"]?$/);
    if (match?.[1] && !match[1].startsWith("!")) patterns.push(match[1]);
  }

  return patterns;
}

function normalizePackageTarget(target: string): string {
  const normalized = toPosixPath(target);
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function toPosix(value: string): string {
  if (!value || value === ".") return ".";
  return value.split(path.sep).join(path.posix.sep);
}
