import type { ScanReport } from "../scanner/report.js";

export function printScanReport(
  report: ScanReport,
  nodeCount: number,
  relationshipCount: number,
  destination: string,
): void {
  console.log("Scan summary");
  console.log(`  Discovered files: ${report.discoveredFiles}`);
  console.log(`  Supported files:  ${report.supportedFiles}`);
  console.log(`  Skipped files:    ${report.skippedFiles}`);
  console.log(`  Parsed files:     ${report.parsedFiles}`);
  console.log(`  Failed files:     ${report.failedFiles.length}`);
  console.log(`  Warnings:         ${report.warnings.length}`);
  console.log(`  Status:           ${report.status}`);
  const classes = report.fileClassifications;
  console.log(
    `  File classes:     production ${classes.production}, test ${classes.test}, fixture ${classes.fixture}, support ${classes.support}, generated ${classes.generated}`,
  );
  console.log(`  Resolved imports: ${report.resolvedImports}`);
  console.log(`  Unresolved rel:   ${report.unresolvedRelativeImports}`);
  if (report.incremental.checked) {
    const incremental = report.incremental;
    console.log(
      `  Incremental:      ${incremental.compatible ? "compatible" : "not compatible"}; added ${incremental.added}, changed ${incremental.changed}, unchanged ${incremental.unchanged}, deleted ${incremental.deleted}`,
    );
    if (incremental.reason) {
      console.log(`  Incremental note: ${incremental.reason}`);
    }
  }
  if (report.parsePlan.requestedMode !== "full") {
    const plan = report.parsePlan;
    console.log(
      `  Parse plan:       requested ${plan.requestedMode}, effective ${plan.effectiveMode}; parse ${plan.filesToParse}, reuse ${plan.filesPlannedForReuse}`,
    );
    if (plan.reason) {
      console.log(`  Parse plan note:  ${plan.reason}`);
    }
  }
  if (report.graphPatch.requested) {
    const patch = report.graphPatch;
    console.log(
      `  Graph write:      ${patch.effectiveMode}; affected ${patch.affectedFiles}, nodes ${patch.nodesWritten}, rels ${patch.relationshipsWritten}`,
    );
    if (patch.reason) {
      console.log(`  Graph write note: ${patch.reason}`);
    }
  }
  console.log(`  Nodes written:    ${nodeCount}`);
  console.log(`  Rels written:     ${relationshipCount}`);
  console.log(`  Destination:      ${destination}`);

  if (report.failedFiles.length > 0) {
    console.log("Failed files");
    for (const failure of report.failedFiles) {
      console.log(`  - ${failure.path}: ${failure.message}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log("Warnings");
    for (const warning of report.warnings) {
      console.log(`  - ${warning.path}: ${warning.message}`);
    }
  }
}
