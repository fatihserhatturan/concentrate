import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  readJsTsPackageJsonResolutionConfig,
  type JsTsPackageJsonResolutionConfig,
} from "./package-json.js";
export { createJsTsConfiguredImportBasePaths } from "./path-mapping.js";
import { parseTsconfig } from "./tsconfig.js";

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
  const emptyConfig: JsTsResolutionConfig = {
    baseUrl: null,
    paths: [],
    packageJson: null,
  };

  let rawConfig: string;
  try {
    rawConfig = await readFile(path.join(rootPath, "tsconfig.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ...emptyConfig,
        packageJson: await readJsTsPackageJsonResolutionConfig(rootPath),
      };
    }

    throw error;
  }

  const tsconfig = parseTsconfig(rawConfig);

  return {
    baseUrl: tsconfig.baseUrl,
    paths: tsconfig.paths,
    packageJson: await readJsTsPackageJsonResolutionConfig(rootPath),
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
