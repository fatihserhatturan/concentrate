import { coreIntegrationRegistry } from "../integrations/default-registry.js";
import type { ScanReport } from "./report.js";
import { GraphBuilder } from "../graph/builder.js";

export async function finalizeGraphRelationships(
  graph: GraphBuilder,
  rootPath: string,
  report: ScanReport,
): Promise<void> {
  for (const resolver of coreIntegrationRegistry.languageResolvers) {
    await resolver.resolve(graph, rootPath, report);
  }

  for (const contributor of coreIntegrationRegistry.semanticContributors) {
    await contributor.contribute(graph, rootPath, report);
  }
}
