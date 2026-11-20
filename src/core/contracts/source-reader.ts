/** Reads source text from the scanned project; the core has no file-system access of its own. */
export interface ISourceReader {
  /** The file's text, or `undefined` when it cannot be read. Takes an absolute path. */
  readFile(absolutePath: string): Promise<string | undefined>;
}
