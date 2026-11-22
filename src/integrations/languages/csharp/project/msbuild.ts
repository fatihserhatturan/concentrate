import type { CSharpProject } from "./types.js";

export type MsbuildInput = {
  /** Every scanned file (scan-relative posix paths): used to resolve ProjectReference targets and to find the props files above a project. */
  files: Set<string>;
  /** Text of each `.csproj` and each `Directory.Build.props` / `Directory.Packages.props` (and other `.props`) file, by path. */
  texts: Map<string, string>;
};

export type MsbuildResult = {
  projects: CSharpProject[];
  /** The project and props files that were interpreted. */
  files: string[];
  unresolved: number;
};

// Wave 1 track A: `.csproj` / `Directory.Build.props` / `Directory.Packages.props` interpreter. `solutions` of each
// project is left empty here; `readCSharpProjectModel` fills it from the solutions.
export function interpretMsbuild(_input: MsbuildInput): MsbuildResult {
  return { projects: [], files: [], unresolved: 0 };
}
