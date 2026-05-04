import path from "node:path";

const importTargetExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
const jsRuntimeExtensions = [".js", ".jsx", ".mjs", ".cjs"];

export function createRelativeImportCandidates(importBasePath: string): string[] {
  const candidates = new Set<string>();
  const extension = path.posix.extname(importBasePath);

  candidates.add(importBasePath);

  if (extension && importTargetExtensions.includes(extension)) {
    const withoutExtension = importBasePath.slice(0, -extension.length);
    if (jsRuntimeExtensions.includes(extension)) {
      for (const candidateExtension of importTargetExtensions) {
        candidates.add(`${withoutExtension}${candidateExtension}`);
      }
    }
  } else {
    for (const candidateExtension of importTargetExtensions) {
      candidates.add(`${importBasePath}${candidateExtension}`);
    }
  }

  for (const candidateExtension of importTargetExtensions) {
    candidates.add(path.posix.join(importBasePath, `index${candidateExtension}`));
  }
  candidates.add(path.posix.join(importBasePath, "__init__.py"));

  return [...candidates];
}

export function createPythonModuleCandidates(importBasePath: string): string[] {
  return [
    `${importBasePath}.py`,
    path.posix.join(importBasePath, "__init__.py"),
  ];
}
