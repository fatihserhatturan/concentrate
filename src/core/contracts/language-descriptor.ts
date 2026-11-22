/** A file the table has detected a language for. */
export type DetectedFile = { filePath: string; language: string };

/**
 * What the scan knows about one language: which files are written in it and
 * whether they are read for declarations, imports and calls. A language is
 * added by registering its descriptor (and a parser); core names none.
 */
export interface LanguageDescriptor {
  /** The value of `File.language`, the key of the parser, and the name a `concentrate.json` extension override uses. */
  readonly id: string;
  /** Human name in tool output (`C++`); defaults to `id`. */
  readonly displayName?: string;
  /** Part of the parse cache fingerprint. */
  readonly version?: string;
  /** True when the parser reads declarations, imports and calls; false for a file that is only a `File` node. */
  readonly code: boolean;
  /** Extensions with their dot, lower case (".ts"). Matched case-sensitively first, then in lower case. */
  readonly extensions?: readonly string[];
  /** Exact file names (`CMakeLists.txt`). */
  readonly fileNames?: readonly string[];
  /** Other file names the language owns (`Dockerfile.dev`); consulted after `fileNames` and before the lower-case extension. */
  readonly matchFileName?: (fileName: string) => boolean;
  /** The language of a file nothing else claims (text of unknown type). At most one descriptor sets it. */
  readonly fallback?: boolean;
  /**
   * Runs once per scan over every discovered file, after detection and before
   * the file limit, and may change `language` in place: a `.h` header is C
   * until the project turns out to have C++ sources.
   */
  readonly refine?: (files: DetectedFile[]) => void;
  /**
   * File-name conventions. These apply to every file in the project, whatever
   * its own language: a `.test.ts` rule still matches a file detected as
   * another language. Directory-name rules (`test/`, `dist/`) are not here.
   */
  /** True for the name of a test file (`foo_test.go`). */
  readonly testFile?: (fileName: string) => boolean;
  /** True for the name of a generated file (`api.generated.ts`). */
  readonly generatedFile?: (fileName: string) => boolean;
  /** True for the name of a test helper (mock, stub, setup file). */
  readonly supportFile?: (fileName: string) => boolean;
  /** Directory names whose files are generated, at any depth (`obj` for .NET build output). */
  readonly generatedDirectories?: readonly string[];
  /** Lockfiles written by this language's package managers; classified as generated and never parsed. */
  readonly lockfiles?: readonly string[];
  /** Gitignore patterns for what the discovery never walks (`node_modules`, `*.min.js`). */
  readonly ignoredPatterns?: readonly string[];
  /**
   * Called for every directory discovery enters, with the names of its
   * entries. Returns gitignore patterns relative to that directory (Go: a
   * module's `/vendor/`).
   */
  readonly ignoredInDirectory?: (entryNames: readonly string[]) => readonly string[];
}

/** The file conventions of every registered language, combined. */
export interface FileConventions {
  readonly testFile: (fileName: string) => boolean;
  readonly generatedFile: (fileName: string) => boolean;
  readonly supportFile: (fileName: string) => boolean;
  readonly lockfiles: ReadonlySet<string>;
  /** Directory names whose files are generated, per language id, from the languages' `generatedDirectories`: they apply to files of that language only. */
  readonly generatedDirectories: ReadonlyMap<string, readonly string[]>;
  /** Exact file names a language claims (`fileNames`): never documentation because of their extension. */
  readonly claimedFileNames: ReadonlySet<string>;
  readonly ignoredPatterns: readonly string[];
  readonly ignoredInDirectory: (entryNames: readonly string[]) => readonly string[];
}
