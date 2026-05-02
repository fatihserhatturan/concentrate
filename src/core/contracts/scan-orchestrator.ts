import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "../scan/result.js";

export interface IScanOrchestrator {
  buildGraph(
    projectPath: string,
    options: BuildCodeGraphOptions,
  ): Promise<BuildCodeGraphResult>;
}
