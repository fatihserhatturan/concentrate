import type { ILanguageResolver } from "../contracts/language-resolver.js";
import type { ISemanticContributor } from "../contracts/semantic-contributor.js";
import type { GraphBuilder } from "../graph/builder.js";
import type { ScanReport } from "./report.js";

export async function finalizeGraphRelationships(
  graph: GraphBuilder,
  rootPath: string,
  report: ScanReport,
  resolvers: readonly ILanguageResolver[],
  contributors: readonly ISemanticContributor[],
): Promise<void> {
  for (const resolver of resolvers) {
    await resolver.resolve(graph, rootPath, report);
  }

  for (const contributor of contributors) {
    await contributor.contribute(graph, rootPath, report);
  }
}
