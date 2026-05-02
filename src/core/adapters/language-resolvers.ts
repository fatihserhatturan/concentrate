import { GraphBuilder } from "../../graph/builder.js";
import { addCallResolutionRelationships } from "../../scanner/resolution/calls.js";
import { addInheritanceRelationships } from "../../scanner/resolution/inheritance.js";
import { addImportResolutionRelationships } from "../../scanner/resolution/imports.js";
import { addImportPackageRelationships } from "../../scanner/workspace-packages.js";
import type { ILanguageResolver } from "../contracts/language-resolver.js";

// Each adapter casts IGraphContributor back to GraphBuilder. The cast is safe
// in practice because build-code-graph.ts always passes a GraphBuilder, and
// Task 88 keeps that flow unchanged. Proper type narrowing arrives in Task 89
// when scanner orchestration moves behind the contracts.

const importResolver: ILanguageResolver = {
  async resolve(graph, rootPath, report) {
    const counts = await addImportResolutionRelationships(
      graph as unknown as GraphBuilder,
      rootPath,
      report,
    );
    report.resolvedImports = counts.resolved;
    report.unresolvedRelativeImports = counts.unresolved;
  },
};

const packageImportResolver: ILanguageResolver = {
  resolve(graph) {
    addImportPackageRelationships(graph as unknown as GraphBuilder);
  },
};

const inheritanceResolver: ILanguageResolver = {
  resolve(graph) {
    addInheritanceRelationships(graph as unknown as GraphBuilder);
  },
};

const callResolver: ILanguageResolver = {
  resolve(graph) {
    addCallResolutionRelationships(graph as unknown as GraphBuilder);
  },
};

export const languageResolvers: readonly ILanguageResolver[] = [
  importResolver,
  packageImportResolver,
  inheritanceResolver,
  callResolver,
];
