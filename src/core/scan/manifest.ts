import path from "node:path";
import type { SupportedSourceFile } from "./source-files.js";
import type { SupportedLanguage } from "./language.js";
import type { IContentHasher, IFileSystem } from "../contracts/file-system.js";

export type ScanManifest = {
  version: 1;
  rootPath: string;
  hashAlgorithm: "sha256";
  generatedAt: string;
  files: ScanManifestFile[];
};

export type ScanManifestFile = {
  path: string;
  language: SupportedLanguage;
  sizeBytes: number;
  mtimeMs: number;
  hash: string;
};

export async function createScanManifest(
  rootPath: string,
  files: SupportedSourceFile[],
  fileSystem: IFileSystem,
  hasher: IContentHasher,
): Promise<ScanManifest> {
  const entries = await Promise.all(
    files.map((file) => createScanManifestFile(rootPath, file, fileSystem, hasher)),
  );

  return {
    version: 1,
    rootPath,
    hashAlgorithm: "sha256",
    generatedAt: new Date().toISOString(),
    files: entries.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

async function createScanManifestFile(
  rootPath: string,
  file: SupportedSourceFile,
  fileSystem: IFileSystem,
  hasher: IContentHasher,
): Promise<ScanManifestFile> {
  const [metadata, content] = await Promise.all([
    fileSystem.stat(file.filePath),
    fileSystem.readFile(file.filePath),
  ]);

  return {
    path: toPosixPath(path.relative(rootPath, file.filePath)),
    language: file.language,
    sizeBytes: metadata.size,
    mtimeMs: metadata.mtimeMs,
    hash: hasher.hash(content),
  };
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

