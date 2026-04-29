import { GraphBuilder } from "../graph/builder.js";
import { addCallResolutionRelationships } from "./resolution/calls.js";
import { addImportResolutionRelationships } from "./resolution/imports.js";
import { addInheritanceRelationships } from "./resolution/inheritance.js";
import type { ScanReport } from "./report.js";

export async function finalizeGraphRelationships(
  graph: GraphBuilder,
  rootPath: string,
  report: ScanReport,
): Promise<void> {
  const resolvedImports = await addImportResolutionRelationships(graph, rootPath);
  report.resolvedImports = resolvedImports.resolved;
  report.unresolvedRelativeImports = resolvedImports.unresolved;

  addInheritanceRelationships(graph);
  addCallResolutionRelationships(graph);
}
