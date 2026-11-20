import type { Declaration, FileInfo } from "../queries/model.js";
import type { ISourceReader } from "./source-reader.js";

/** What a language session may ask the unused-exports analysis for. */
export type UnusedAnalysisContext = {
  /** Absolute path of the scanned repository, or null when it is unknown. */
  readonly rootPath: string | null;
  /** The scan's declarations of the rule's own language. */
  readonly declarations: readonly Declaration[];
  /** The unit (package, crate, header/source pair...) a file belongs to. */
  unitOf(file: string): string;
  /** Annotation or decorator names written on a declaration (`Override`, `org.junit.Test`). */
  annotationsOf(declarationId: string): readonly string[];
  /** Reads every scanned file the predicate accepts (nothing without a repository path). */
  forEachSource(include: (file: string) => boolean, visit: (file: string, text: string) => void): Promise<void>;
};

/** Per-analysis state of one language, built once when the scan holds declarations of it. */
export type UnusedLanguageSession = {
  /** Another unit mentions the declaration's name, which counts as a use the graph has no edge for. */
  isMentionedElsewhere?(declaration: Declaration): boolean;
  /** Mentions of the name within its own unit, replacing the in-file count for dead functions. A very large number means never judge it. */
  deadFunctionMentions?(declaration: Declaration): number;
};

/**
 * What one language adds to the unused-exports analysis. The core owns the
 * algorithm (export index, imports through barrels, calls and class links);
 * a rules object only says which declarations are public API, which files are
 * entry points and which names other units use without an edge.
 */
export interface IUnusedExportRules {
  readonly id: string;
  /** The `File.language` values this rule judges. */
  readonly languages: readonly string[];
  supports(file: string): boolean;
  /** Skip counters this language reports, in output order. */
  readonly skipReasons?: readonly string[];
  /** A `from m import *` takes every public name of `m`. */
  readonly wildcardImportUsesWholeFile?: boolean;
  /** Files that belong together as one unit; a use from another unit counts. Default: the file itself. */
  unitOf?(file: string, info: FileInfo | undefined): string;
  /**
   * Which declarations are candidates at all. Default: exported non-method declarations (then
   * `isPublicApi` narrows them). A language that judges what is NOT public (Java: package-private and
   * private types, methods and fields) says so here; it also makes the analysis load that language's fields.
   */
  judges?(declaration: Declaration): boolean;
  /** Whether the declaration can leave its unit (false: not judged at all). */
  isPublicApi?(declaration: Declaration): boolean;
  /** Skip reason checked before the test-file rule (a binary crate has no dependents). */
  binaryReason?(declaration: Declaration, info: FileInfo): string | null;
  /** Skip reason for entry points that run without a caller, checked after the test-file rule. */
  entryReason?(declaration: Declaration, info: FileInfo): string | null;
  /**
   * Scan-relative files a package exposes as its entry points (everything
   * they export counts as used). `packages` are the scan's packages, or the
   * scan root when it has none; `files` are the scanned file paths.
   */
  packageEntries?(
    reader: ISourceReader,
    packages: readonly { path?: unknown; relativePath?: unknown }[],
    files: ReadonlyMap<string, unknown>,
  ): Promise<string[]>;
  /** The session reads `annotationsOf`; the analysis loads annotations only for rules that say so. */
  readonly usesAnnotations?: boolean;
  /** Called once, only when the scan holds declarations the rule supports. */
  createSession?(context: UnusedAnalysisContext): Promise<UnusedLanguageSession>;
  /** The language's paragraph of the find_unused_exports note. */
  readonly note?: string;
}
