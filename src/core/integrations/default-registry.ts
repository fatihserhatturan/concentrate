import { GraphBuilder } from "../../graph/builder.js";
import { addCallResolutionRelationships } from "../../scanner/resolution/calls.js";
import { addInheritanceRelationships } from "../../scanner/resolution/inheritance.js";
import { addImportResolutionRelationships } from "../../scanner/resolution/imports.js";
import { addImportPackageRelationships } from "../../scanner/workspace-packages.js";
import { javascriptParser, typescriptParser } from "../../parsers/languages/javascript-like.js";
import { pythonParser } from "../../parsers/languages/python.js";
import { goParser } from "../../parsers/languages/go.js";
import { rustParser } from "../../parsers/languages/rust.js";
import {
  javascriptLanguageParser,
  typescriptLanguageParser,
} from "../../integrations/languages/js-ts/index.js";
import { pythonLanguageParser } from "../../integrations/languages/python/index.js";
import { goLanguageParser } from "../../integrations/languages/go/index.js";
import { rustLanguageParser } from "../../integrations/languages/rust/index.js";
import {
  nestjsModulesContributor,
  nestjsInjectionContributor,
  instanceMethodContributor,
} from "../../integrations/frameworks/js-ts/nestjs.js";
import { routePathContributor } from "../../integrations/frameworks/js-ts/fastify.js";
import { envConfigContributor } from "../../integrations/frameworks/js-ts/env-config.js";
import { dataAccessContributor } from "../../integrations/frameworks/js-ts/data-access.js";
import type { ILanguageResolver } from "../contracts/language-resolver.js";
import { CoreIntegrationRegistry } from "./registry.js";

export const coreIntegrationRegistry = createDefaultCoreIntegrationRegistry();

export function createDefaultCoreIntegrationRegistry(): CoreIntegrationRegistry {
  const registry = new CoreIntegrationRegistry();

  for (const parser of [javascriptParser, typescriptParser, pythonParser, goParser, rustParser]) {
    registry.registerLanguageParser(parser, { scan: true, integration: false });
  }

  for (const parser of [
    javascriptLanguageParser,
    typescriptLanguageParser,
    pythonLanguageParser,
    goLanguageParser,
    rustLanguageParser,
  ]) {
    registry.registerLanguageParser(parser, { scan: false, integration: true });
  }

  for (const resolver of createDefaultLanguageResolvers()) {
    registry.registerLanguageResolver(resolver);
  }

  for (const contributor of [
    nestjsModulesContributor,
    nestjsInjectionContributor,
    instanceMethodContributor,
    routePathContributor,
    envConfigContributor,
    dataAccessContributor,
  ]) {
    registry.registerSemanticContributor(contributor);
  }

  return registry;
}

function createDefaultLanguageResolvers(): ILanguageResolver[] {
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

  return [
    importResolver,
    packageImportResolver,
    inheritanceResolver,
    callResolver,
  ];
}
