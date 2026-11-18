import type { ILanguageResolver } from "../contracts/language-resolver.js";
import type { ISemanticContributor, ScanSettings } from "../contracts/semantic-contributor.js";
import type { GraphBuilder } from "../graph/builder.js";
import type { ScanReport } from "./report.js";

export async function finalizeGraphRelationships(
  graph: GraphBuilder,
  rootPath: string,
  report: ScanReport,
  resolvers: readonly ILanguageResolver[],
  contributors: readonly ISemanticContributor[],
  files: readonly string[],
  settings: ScanSettings = { apiOrigins: [] },
  // Runs after each resolver and contributor (ScanDependencies.collectGarbage).
  afterStep?: () => void,
): Promise<void> {
  for (const resolver of resolvers) {
    await resolver.resolve(graph, rootPath, report);
    afterStep?.();
  }

  for (const contributor of contributors) {
    await contributor.contribute(graph, rootPath, report, files, settings);
    afterStep?.();
  }
}
