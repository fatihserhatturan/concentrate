import { readdir, stat } from "node:fs/promises";
import type { IFileSystem } from "../../../../core/contracts/file-system.js";

// The resolution config is read from the file system directly (integrations may use node:fs; they
// may not import the adapters), so the workspace walk gets the directory reading it needs here.
export const nodeWalkFileSystem: Pick<IFileSystem, "readDirectory" | "stat"> = {
  readDirectory: async (absolutePath) =>
    (await readdir(absolutePath, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  stat: async (absolutePath) => {
    const s = await stat(absolutePath);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
  },
};
