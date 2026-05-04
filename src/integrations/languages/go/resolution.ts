import { readFile } from "node:fs/promises";
import path from "node:path";

export type GoResolutionConfig = {
  moduleName: string | null;
};

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

export function resolveGoImport(
  source: string,
  fileIdByRelativePath: Map<string, string>,
  goConfig: GoResolutionConfig,
): string | null {
  if (!goConfig.moduleName || !source.startsWith(`${goConfig.moduleName}/`)) {
    return null;
  }

  const pkgPath = source.slice(goConfig.moduleName.length + 1);

  for (const [relativePath, fileId] of fileIdByRelativePath) {
    if (relativePath.startsWith(`${pkgPath}/`) && relativePath.endsWith(".go")) {
      return fileId;
    }
  }

  return null;
}
