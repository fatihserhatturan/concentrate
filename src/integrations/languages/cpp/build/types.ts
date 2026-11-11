// What the C and C++ build files (CMake, Makefiles, compile_commands.json)
// tell the scan: the targets with their sources and links, and the include
// directories and definitions each source file is compiled with.

export type BuildSystem = "cmake" | "make";

export type TargetType = "executable" | "static" | "shared" | "module" | "object" | "interface" | "library";

export type BuildTarget = {
  system: BuildSystem;
  name: string;
  type: TargetType;
  // Directory of the build file (relative to the scan root, "" for the root).
  dir: string;
  // The build file (relative to the scan root) and the line that creates the target.
  file: string;
  line: number;
  // Scanned files the target compiles (sources and the headers it lists), relative to the root.
  sources: string[];
  // Targets this one links to, by `${system}:${name}` key, with the CMake
  // visibility (`public` for the make `-l` and the keyword-less form).
  links: Array<{ target: string; visibility: "public" | "private" | "interface" }>;
  // Include directories relative to the scan root.
  includePrivate: string[];
  includeInterface: string[];
  // Definitions (`NAME` or `NAME=value`).
  definitionsPrivate: string[];
  definitionsInterface: string[];
  // Arguments that named something the reader could not resolve (an unset
  // variable, a generator expression, a source that is no scanned file).
  unresolved: number;
};

export type BuildModel = {
  targets: BuildTarget[];
  // Include directories and definitions per compiled file, relative to the root.
  includeDirsByFile: Map<string, string[]>;
  definitionsByFile: Map<string, Map<string, string>>;
  // Build files read (relative to the scan root).
  files: string[];
  // Arguments the readers could not resolve, summed over every target and directory command.
  unresolved: number;
};

export function targetKey(target: Pick<BuildTarget, "system" | "name">): string {
  return `${target.system}:${target.name}`;
}

export function emptyBuildModel(): BuildModel {
  return { targets: [], includeDirsByFile: new Map(), definitionsByFile: new Map(), files: [], unresolved: 0 };
}
