import type { CSharpSolution } from "./types.js";

export type SolutionInput = {
  /** Every scanned file (scan-relative posix paths): used to tell whether a listed project exists. */
  files: Set<string>;
  /** Text of each `.sln` and `.slnx` file, by path. */
  texts: Map<string, string>;
};

export type SolutionResult = {
  solutions: CSharpSolution[];
  unresolved: number;
};

// Wave 1 track B: `.sln` line reader and `.slnx` XML reader.
export function interpretSolutions(_input: SolutionInput): SolutionResult {
  return { solutions: [], unresolved: 0 };
}
