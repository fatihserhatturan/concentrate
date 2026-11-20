import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
import type { IContentHasher, IFileSystem } from "../../core/contracts/file-system.js";

/** Reads the project's files with node:fs. */
export const nodeFileSystem: IFileSystem = {
  readFile: (absolutePath) => readFile(absolutePath),
  readTextFile: (absolutePath) => readFile(absolutePath, "utf8"),
  readDirectory: async (absolutePath) => {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  },
  stat: async (absolutePath) => {
    const s = await stat(absolutePath);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
  },
  exists: (absolutePath) => access(absolutePath).then(() => true, () => false),
};

/** SHA-256 with node:crypto. */
export const nodeContentHasher: IContentHasher = {
  hash: (content) => createHash("sha256").update(content).digest("hex"),
};
