import type { ScanReport } from "../scan/report.js";
import type { IGraphContributor } from "./graph-contributor.js";

// Scan settings contributors read.
export type ScanSettings = {
  // Origins (`https://api.example.com`) that serve the scanned project's own
  // routes: outbound calls to them are matched as same-origin paths.
  apiOrigins: readonly string[];
};

export interface ISemanticContributor {
  contribute(
    graph: IGraphContributor,
    rootPath: string,
    report: ScanReport,
    // Every file the scan discovered (absolute paths, include/exclude and
    // .gitignore applied), source or not.
    files: readonly string[],
    settings: ScanSettings,
  ): Promise<void> | void;
}
