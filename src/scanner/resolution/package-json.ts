import path from "node:path";
import { readFile } from "node:fs/promises";
import { extractPackageExportTargets } from "./package-json-exports.js";

export type JsTsPackageJsonResolutionConfig = {
  name: string | null;
  main: string | null;
  types: string | null;
  exports: unknown;
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
