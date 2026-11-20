import type { ScanReport } from "../scan/report.js";
import type { IGraphContributor } from "./graph-contributor.js";
import type { ScanLifecycleContext } from "./semantic-contributor.js";

export interface ILanguageResolver {
  // Stable name of the resolver.
  readonly id: string;
  // Part of the parse cache fingerprint.
  readonly version?: string;
  // Called once per scan, before any resolver or contributor runs.
  prepare?(context: ScanLifecycleContext): Promise<void> | void;
  resolve(
    graph: IGraphContributor,
    rootPath: string,
    report: ScanReport,
  ): Promise<void> | void;
  // Called once per scan after every contributor has run, also when a step failed.
  finish?(context: ScanLifecycleContext): Promise<void> | void;
}
