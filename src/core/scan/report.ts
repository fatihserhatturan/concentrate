export type {
  GraphPatchReport,
  ScanFailure,
  ScanReport,
  ScanStatus,
  ScanWarning,
} from "../../scanner/report.js";

export {
  addScanWarning,
  addUniqueScanWarning,
  createScanFailure,
  createScanReport,
  didFailFast,
  didPartiallySucceed,
} from "../../scanner/report.js";
