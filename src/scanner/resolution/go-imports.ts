import type { GoResolutionConfig } from "./config.js";

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
