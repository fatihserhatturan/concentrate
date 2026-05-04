import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export type FileStats = {
  size: number;
  mtimeMs: number;
};

export interface FileSystemReader {
  readFile(filePath: string): Promise<Buffer>;
  readTextFile(filePath: string): Promise<string>;
  stat(filePath: string): Promise<FileStats>;
  hash(content: Buffer, algorithm: string): string;
}

export const nodeFileSystemReader: FileSystemReader = {
  readFile: (filePath) => readFile(filePath),
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  stat: async (filePath) => {
    const s = await stat(filePath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  },
  hash: (content, algorithm) => createHash(algorithm).update(content).digest("hex"),
};
