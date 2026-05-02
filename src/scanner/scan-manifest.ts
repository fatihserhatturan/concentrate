import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SupportedLanguage } from "./language.js";
import type { SupportedSourceFile } from "./source-files.js";

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

export type IncrementalEligibility = {
  checked: boolean;
  compatible: boolean;
  reason: string | null;
  previousManifestPath: string | null;
  added: number;
  changed: number;
  unchanged: number;
  deleted: number;
};

export type ManifestDiff = IncrementalEligibility & {
  addedFiles: string[];
  changedFiles: string[];
  unchangedFiles: string[];
  deletedFiles: string[];
};

export async function createScanManifest(
  rootPath: string,
  files: SupportedSourceFile[],
): Promise<ScanManifest> {
  const entries = await Promise.all(
    files.map((file) => createScanManifestFile(rootPath, file)),
  );

  return {
    version: 1,
    rootPath,
    hashAlgorithm: "sha256",
    generatedAt: new Date().toISOString(),
    files: entries.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export async function readScanManifest(filePath: string): Promise<ScanManifest> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isScanManifest(parsed)) {
    throw new Error(`Invalid scan manifest: ${filePath}`);
  }
  return parsed;
}

export function compareScanManifests(
  current: ScanManifest,
  previous: ScanManifest,
  previousManifestPath: string,
): ManifestDiff {
  const incompatibleReason = manifestCompatibilityReason(current, previous);
  if (incompatibleReason) {
    return {
      checked: true,
      compatible: false,
      reason: incompatibleReason,
      previousManifestPath,
      added: 0,
      changed: 0,
      unchanged: 0,
      deleted: 0,
      addedFiles: [],
      changedFiles: [],
      unchangedFiles: [],
      deletedFiles: [],
    };
  }

  const previousFiles = new Map(previous.files.map((file) => [file.path, file]));
  const currentFiles = new Map(current.files.map((file) => [file.path, file]));
  const addedFiles: string[] = [];
  const changedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const file of current.files) {
    const previousFile = previousFiles.get(file.path);
    if (!previousFile) {
      addedFiles.push(file.path);
      continue;
    }

    if (file.hash === previousFile.hash && file.language === previousFile.language) {
      unchangedFiles.push(file.path);
    } else {
      changedFiles.push(file.path);
    }
  }

  for (const file of previous.files) {
    if (!currentFiles.has(file.path)) {
      deletedFiles.push(file.path);
    }
  }

  return {
    checked: true,
    compatible: true,
    reason: null,
    previousManifestPath,
    added: addedFiles.length,
    changed: changedFiles.length,
    unchanged: unchangedFiles.length,
    deleted: deletedFiles.length,
    addedFiles,
    changedFiles,
    unchangedFiles,
    deletedFiles,
  };
}

export function createUncheckedIncrementalEligibility(): IncrementalEligibility {
  return {
    checked: false,
    compatible: false,
    reason: "No previous manifest provided",
    previousManifestPath: null,
    added: 0,
    changed: 0,
    unchanged: 0,
    deleted: 0,
  };
}

async function createScanManifestFile(
  rootPath: string,
  file: SupportedSourceFile,
): Promise<ScanManifestFile> {
  const [metadata, content] = await Promise.all([
    stat(file.filePath),
    readFile(file.filePath),
  ]);

  return {
    path: toPosixPath(path.relative(rootPath, file.filePath)),
    language: file.language,
    sizeBytes: metadata.size,
    mtimeMs: metadata.mtimeMs,
    hash: createHash("sha256").update(content).digest("hex"),
  };
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function manifestCompatibilityReason(current: ScanManifest, previous: ScanManifest): string | null {
  if (previous.version !== current.version) {
    return `Manifest version mismatch: previous ${previous.version}, current ${current.version}`;
  }
  if (previous.hashAlgorithm !== current.hashAlgorithm) {
    return `Manifest hash algorithm mismatch: previous ${previous.hashAlgorithm}, current ${current.hashAlgorithm}`;
  }
  return null;
}

function isScanManifest(value: unknown): value is ScanManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ScanManifest>;
  return candidate.version === 1
    && candidate.hashAlgorithm === "sha256"
    && typeof candidate.rootPath === "string"
    && typeof candidate.generatedAt === "string"
    && Array.isArray(candidate.files)
    && candidate.files.every(isScanManifestFile);
}

function isScanManifestFile(value: unknown): value is ScanManifestFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ScanManifestFile>;
  return typeof candidate.path === "string"
    && typeof candidate.language === "string"
    && typeof candidate.sizeBytes === "number"
    && typeof candidate.mtimeMs === "number"
    && typeof candidate.hash === "string";
}
