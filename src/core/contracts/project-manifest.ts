// A package an ecosystem declares in a manifest (`package.json`,
// `pyproject.toml`, `Cargo.toml`, ...). Core builds Package nodes and their
// relationships from what the readers return; it does not know the formats.
export type DeclaredPackage = {
  // Directory of the manifest, relative to the scan root, posix ("." for the root).
  dir: string;
  name: string | null;
  version: string | null;
  isPrivate: boolean;
  // The tool that manages the package (`pnpm@9`, `pip`, ...).
  manager: string | null;
  // Declared dependencies; a dependency on another declared package becomes a PACKAGE_IMPORTS_PACKAGE edge.
  dependencies: Array<{ name: string; type: string }>;
  // The manifest file name, which prefixes the package's config values.
  metadataFile: string;
};

// A manifest value shown as a ConfigValue of the repository.
export type ProjectConfigValue = {
  // File the value was read from, e.g. `tsconfig.json`.
  source: string;
  // Key within the file, e.g. `compilerOptions.target`.
  key: string;
  value: string | number | boolean;
};

import type { IFileSystem } from "./file-system.js";

export type ProjectManifestContext = {
  rootPath: string;
  // Read access to the project, for finding manifests (`walkFiles`).
  fileSystem: IFileSystem;
  // Files of the project, relative to the scan root, posix. Empty when config values are read
  // (before the files are parsed).
  filePaths: readonly string[];
  // Report a manifest that could not be read or parsed; the scan goes on.
  warn: (filePath: string, error: unknown) => void;
};

export interface IProjectManifestReader {
  readonly id: string;
  // Part of the parse cache fingerprint.
  readonly version?: string;
  // Packages the ecosystem declares. When two readers declare the same directory, the first registered wins.
  readPackages?(context: ProjectManifestContext): Promise<DeclaredPackage[]>;
  // Values of the project's own manifests, added to the repository node in order.
  readConfig?(context: ProjectManifestContext): Promise<ProjectConfigValue[]>;
}
