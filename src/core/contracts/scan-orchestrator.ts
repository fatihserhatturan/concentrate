import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "../../scanner/build-code-graph-types.js";

export interface IScanOrchestrator {
  buildGraph(
    projectPath: string,
    options: BuildCodeGraphOptions,
  ): Promise<BuildCodeGraphResult>;
}
