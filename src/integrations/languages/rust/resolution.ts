import path from "node:path";

export function resolveRustImport(
  source: string,
  importerFileId: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const importerRelativePath = importerFileId.slice("file:".length);
  const importerDir = path.posix.dirname(toPosixPath(importerRelativePath));

  if (source.startsWith("crate::")) {
    return resolveRustCrateImport(source.slice("crate::".length), fileIdByRelativePath);
  }

  if (source.startsWith("super::")) {
    return resolveRustSuperImport(source, importerDir, fileIdByRelativePath);
  }

  return resolveRustModuleByName(source, importerDir, fileIdByRelativePath);
}

function resolveRustCrateImport(
  colonPath: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const segments = colonPath.split("::");

  for (let len = segments.length; len >= 1; len--) {
    const modulePath = segments.slice(0, len).join("/");
    for (const prefix of ["", "src/"]) {
      for (const candidate of rustModuleCandidates(`${prefix}${modulePath}`)) {
        const fileId = fileIdByRelativePath.get(candidate);
        if (fileId) return fileId;
      }
    }
  }

  return null;
}

function resolveRustSuperImport(
  source: string,
  importerDir: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const segments = source.split("::");
  let superCount = 0;
  while (segments[superCount] === "super") superCount++;

  let baseDir = importerDir;
  for (let i = 0; i < superCount; i++) {
    baseDir = path.posix.dirname(baseDir);
  }

  const remainingSegments = segments.slice(superCount);
  if (remainingSegments.length === 0) return null;

  for (let len = remainingSegments.length; len >= 1; len--) {
    const modulePath = remainingSegments.slice(0, len).join("/");
    const basePath = baseDir === "." ? modulePath : `${baseDir}/${modulePath}`;
    for (const candidate of rustModuleCandidates(basePath)) {
      const fileId = fileIdByRelativePath.get(candidate);
      if (fileId) return fileId;
    }
  }

  return null;
}

function resolveRustModuleByName(
  name: string,
  importerDir: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const basePath = importerDir === "." ? name : `${importerDir}/${name}`;
  for (const candidate of rustModuleCandidates(basePath)) {
    const fileId = fileIdByRelativePath.get(candidate);
    if (fileId) return fileId;
  }
  return null;
}

function rustModuleCandidates(basePath: string): string[] {
  return [`${basePath}.rs`, `${basePath}/mod.rs`];
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
