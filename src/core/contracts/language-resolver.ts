import type { ScanReport } from "../scan/report.js";
import type { IGraphContributor } from "./graph-contributor.js";

export interface ILanguageResolver {
  resolve(
    graph: IGraphContributor,
    rootPath: string,
    report: ScanReport,
  ): Promise<void> | void;
}
