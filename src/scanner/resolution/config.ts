import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  type ConfigWarningSink,
  readJsTsPackageJsonResolutionConfig,
  type JsTsPackageJsonResolutionConfig,
} from "./package-json.js";
export { createJsTsConfiguredImportBasePaths } from "./path-mapping.js";
import { parseTsconfig } from "./tsconfig.js";

async function resolveExtendsTarget(extendsValue: string, fromDir: string): Promise<string | null> {
  if (extendsValue.startsWith(".")) {
    const resolved = path.resolve(fromDir, extendsValue);
    return path.extname(resolved) ? resolved : `${resolved}.json`;
  }
  let current = fromDir;
  while (true) {
    const candidate = path.join(current, "node_modules", extendsValue, "tsconfig.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // not found here
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readTsconfigChain(
  tsconfigPath: string,
  onWarning?: ConfigWarningSink,
  visited = new Set<string>(),
): Promise<{ baseUrl: string | null; paths: JsTsPathMapping[] }> {
  const resolved = path.resolve(tsconfigPath);
  if (visited.has(resolved)) return { baseUrl: null, paths: [] };
  visited.add(resolved);

  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch {
    return { baseUrl: null, paths: [] };
  }

  let parsed: ReturnType<typeof parseTsconfig>;
  try {
    parsed = parseTsconfig(raw);
  } catch (error) {
    onWarning?.(resolved, error);
    return { baseUrl: null, paths: [] };
  }
  const dir = path.dirname(resolved);
  let parent: { baseUrl: string | null; paths: JsTsPathMapping[] } = { baseUrl: null, paths: [] };

  if (parsed.extendsPath) {
    const parentPath = await resolveExtendsTarget(parsed.extendsPath, dir);
    if (parentPath) parent = await readTsconfigChain(parentPath, onWarning, visited);
  }

  return {
    baseUrl: parsed.hasBaseUrl ? parsed.baseUrl : parent.baseUrl,
    paths: parsed.hasPaths ? parsed.paths : parent.paths,
  };
}

export type JsTsResolutionConfig = {
  baseUrl: string | null;
  paths: JsTsPathMapping[];
  packageJson: JsTsPackageJsonResolutionConfig | null;
};

export type JsTsPathMapping = {
  pattern: string;
  targets: string[];
};

export type GoResolutionConfig = {
  moduleName: string | null;
};

export async function readJsTsResolutionConfig(rootPath: string): Promise<JsTsResolutionConfig> {
  return readJsTsResolutionConfigWithWarnings(rootPath);
}

export async function readJsTsResolutionConfigWithWarnings(
  rootPath: string,
  onWarning?: ConfigWarningSink,
): Promise<JsTsResolutionConfig> {
  const emptyConfig: JsTsResolutionConfig = {
    baseUrl: null,
    paths: [],
    packageJson: null,
  };

  const tsconfigPath = path.join(rootPath, "tsconfig.json");
  try {
    await readFile(tsconfigPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ...emptyConfig,
        packageJson: await readJsTsPackageJsonResolutionConfig(rootPath, onWarning),
      };
    }

    throw error;
  }

  const [tsconfig, packageJson] = await Promise.all([
    readTsconfigChain(tsconfigPath, onWarning),
    readJsTsPackageJsonResolutionConfig(rootPath, onWarning),
  ]);

  return {
    baseUrl: tsconfig.baseUrl,
    paths: tsconfig.paths,
    packageJson,
  };
}

export async function readGoResolutionConfig(rootPath: string): Promise<GoResolutionConfig> {
  let raw: string;
  try {
    raw = await readFile(path.join(rootPath, "go.mod"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { moduleName: null };
    }
    throw error;
  }

  const match = raw.match(/^module\s+(\S+)/m);
  return { moduleName: match?.[1] ?? null };
}
