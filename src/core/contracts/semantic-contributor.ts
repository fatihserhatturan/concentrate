import type { ScanReport } from "../scan/report.js";
import type { IGraphContributor } from "./graph-contributor.js";

// Scan settings contributors read.
export type ScanSettings = {
  // Origins (`https://api.example.com`) that serve the scanned project's own
  // routes: outbound calls to them are matched as same-origin paths.
  apiOrigins: readonly string[];
};

// What the per-scan lifecycle hooks (`prepare`, `finish`) of contributors and
// language resolvers receive.
export type ScanLifecycleContext = {
  rootPath: string;
  // Every file the scan discovered (absolute paths), source or not.
  files: readonly string[];
  report: ScanReport;
  settings: ScanSettings;
};

export interface ISemanticContributor {
  // Stable name of the contributor; unique in a registry. Others name it in `dependsOn`.
  readonly id: string;
  // Part of the parse cache fingerprint: bump it when the plugin's output changes.
  readonly version?: string;
  // Ids of the contributors that must run before this one. Without it a
  // contributor runs in registration order.
  readonly dependsOn?: readonly string[];
  // Called once per scan, before any language resolver or contributor runs.
  prepare?(context: ScanLifecycleContext): Promise<void> | void;
  contribute(
    graph: IGraphContributor,
    rootPath: string,
    report: ScanReport,
    // Every file the scan discovered (absolute paths, include/exclude and
    // .gitignore applied), source or not.
    files: readonly string[],
    settings: ScanSettings,
  ): Promise<void> | void;
  // Called once per scan after every contributor has run, also when a step failed.
  finish?(context: ScanLifecycleContext): Promise<void> | void;
}
