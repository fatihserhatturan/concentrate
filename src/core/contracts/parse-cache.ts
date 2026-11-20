import type { ParsedSourceFile } from "../graph/model.js";

/**
 * Per-file parse results reused while a file and the parsers are unchanged.
 * Storage is the implementation's business; the core only looks results up and
 * offers new ones. Hits, misses and writes are counted in the scan's report.
 */
export interface IParseCache {
  /** The entry key for a project-relative path and the content hash of the file. */
  key(relativePath: string, contentHash: string): string;
  /** The cached parse for `key`, or `null` on a miss (missing or unreadable entries are misses). */
  read(key: string): Promise<ParsedSourceFile | null>;
  /** Stores the parser's own output; a cache that cannot be written only costs speed. */
  write(key: string, parsed: ParsedSourceFile): Promise<void>;
  /** Drops this project's entries that the scan did not look up. */
  prune(): Promise<void>;
}
