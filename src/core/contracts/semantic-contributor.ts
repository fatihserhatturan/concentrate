import type { ScanReport } from "../../scanner/report.js";
import type { IGraphContributor } from "./graph-contributor.js";

export interface ISemanticContributor {
  contribute(
    graph: IGraphContributor,
    rootPath: string,
    report: ScanReport,
  ): Promise<void> | void;
}
