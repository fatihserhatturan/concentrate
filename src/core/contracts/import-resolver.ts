import type { GraphNode } from "../graph/model.js";
import type { IGraphContributor } from "./graph-contributor.js";

/** What one scan offers an import resolver when it builds its session. */
export type ImportResolutionContext = {
  graph: IGraphContributor;
  rootPath: string;
  /** Every `File` node of the scan by its posix relative path. */
  fileIdByRelativePath: ReadonlyMap<string, string>;
  /** The file each `Import` node belongs to. */
  importerFileIdByImportId: ReadonlyMap<string, string>;
  /** A warning on the scan report (a config file that could not be read); the same warning is kept once. */
  addWarning(warning: { path: string; message: string }): void;
};

/**
 * What one import resolves to. `fileIds` are the files it reaches (a Go import
 * is every file of a package); none means unresolved, which counts against the
 * scan only when `expected` (an external package or a system header does not).
 */
export type ImportResolution = { fileIds: readonly string[]; expected: boolean };

/** Resolves the imports of one scan; built once, the first time an import of a supported file is seen. */
export type ImportResolutionSession = (
  importNode: GraphNode,
  importerFileId: string,
  source: string,
) => ImportResolution;

/**
 * Import resolution for one language or file format. The import resolver
 * hands each `Import` node to the first registered resolver that supports the
 * importing file, which links it to the files it reaches with `RESOLVES_TO`.
 */
export interface ILanguageImportResolver {
  readonly id: string;
  readonly version?: string;
  supports(fileId: string): boolean;
  /**
   * Build the session whenever the scan has a file the resolver supports, not
   * only an import from one: for a resolver whose session annotates files or
   * reports config problems of its own. Costs the session of a project that
   * imports nothing, so leave it off otherwise.
   */
  readonly sessionWithoutImports?: boolean;
  /** Reads the project config the language needs; not called when the scan imports nothing from a supported file. */
  createSession(context: ImportResolutionContext): Promise<ImportResolutionSession>;
}
