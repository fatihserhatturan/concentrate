/** One entry of a directory listing; a symbolic link reports `isSymbolicLink` and neither of the others. */
export type DirectoryEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

/** What a path is, following symbolic links. */
export type FileStat = {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
};

/**
 * Read access to the scanned project's files; the core has no file-system access of its own.
 * Takes absolute paths. A failure rejects with an error carrying the platform's `code`
 * (`ENOENT`, `ENOTDIR`, `EISDIR`), which callers may inspect.
 */
export interface IFileSystem {
  readFile(absolutePath: string): Promise<Uint8Array>;
  readTextFile(absolutePath: string): Promise<string>;
  readDirectory(absolutePath: string): Promise<DirectoryEntry[]>;
  stat(absolutePath: string): Promise<FileStat>;
  exists(absolutePath: string): Promise<boolean>;
}

/** SHA-256 of file contents, as lowercase hex. */
export interface IContentHasher {
  hash(content: Uint8Array | string): string;
}
