import { GraphBuilder } from "../graph/builder.js";
import { addCallResolutionRelationships } from "./resolution/calls.js";
import { addDataAccessRelationships } from "./resolution/data-access.js";
import { addEnvAndConfigRelationships } from "./resolution/env-config.js";
import { addImportResolutionRelationships } from "./resolution/imports.js";
import { addInheritanceRelationships } from "./resolution/inheritance.js";
import { addInjectionRelationships } from "./resolution/injections.js";
import { addInstanceMethodResolutionRelationships } from "./resolution/instances.js";
import { addNestJsModuleRelationships } from "./resolution/nestjs-modules.js";
import { resolveRouteFullPaths } from "./resolution/route-paths.js";
import type { ScanReport } from "./report.js";

export async function finalizeGraphRelationships(
  graph: GraphBuilder,
  rootPath: string,
  report: ScanReport,
): Promise<void> {
  const resolvedImports = await addImportResolutionRelationships(graph, rootPath, report);
  report.resolvedImports = resolvedImports.resolved;
  report.unresolvedRelativeImports = resolvedImports.unresolved;

  addInheritanceRelationships(graph);
  addNestJsModuleRelationships(graph);
  addInjectionRelationships(graph);
  addInstanceMethodResolutionRelationships(graph);
  addCallResolutionRelationships(graph);
  resolveRouteFullPaths(graph);
  addEnvAndConfigRelationships(graph);
  addDataAccessRelationships(graph);
}
