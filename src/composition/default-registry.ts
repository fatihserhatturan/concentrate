import { addImportResolutionRelationships } from "../integrations/resolution/imports.js";
import { addImportPackageRelationships } from "../core/scan/workspace-packages.js";
import { addCallResolutionRelationships } from "../core/scan/resolution/calls.js";
import { addInheritanceRelationships } from "../core/scan/resolution/inheritance.js";
import { astroParser, htmlParser, javascriptParser, svelteParser, typescriptParser, vueParser } from "../integrations/frameworks/js-ts/scanner.js";
import { pythonParser } from "../integrations/languages/python/parser.js";
import { goParser } from "../integrations/languages/go/parser.js";
import { rustParser } from "../integrations/languages/rust/parser.js";
import {
  nestjsModulesContributor,
  nestjsInjectionContributor,
  instanceMethodContributor,
} from "../integrations/frameworks/js-ts/nestjs.js";
import { routePathContributor } from "../integrations/frameworks/js-ts/fastify.js";
import { routeHandlerContributor } from "../integrations/frameworks/js-ts/express-koa.js";
import { envConfigContributor } from "../integrations/frameworks/js-ts/env-config.js";
import { dataAccessContributor } from "../integrations/frameworks/js-ts/data-access.js";
import { componentGraphContributor } from "../integrations/frameworks/js-ts/resolution/component-graph.js";
import { nextjsPagesContributor, nextjsRoutesContributor } from "../integrations/frameworks/js-ts/nextjs.js";
import type { ILanguageResolver } from "../core/contracts/language-resolver.js";
import { CoreIntegrationRegistry } from "../core/integrations/registry.js";

export { CoreIntegrationRegistry };

export function createDefaultCoreIntegrationRegistry(): CoreIntegrationRegistry {
  const registry = new CoreIntegrationRegistry();

  for (const parser of [javascriptParser, typescriptParser, htmlParser, vueParser, svelteParser, astroParser, pythonParser, goParser, rustParser]) {
    registry.registerLanguageParser(parser);
  }

  for (const resolver of createDefaultLanguageResolvers()) {
    registry.registerLanguageResolver(resolver);
  }

  for (const contributor of [
    nestjsModulesContributor,
    nestjsInjectionContributor,
    instanceMethodContributor,
    routeHandlerContributor,
    routePathContributor,
    nextjsRoutesContributor,
    envConfigContributor,
    dataAccessContributor,
    componentGraphContributor,
    nextjsPagesContributor,
  ]) {
    registry.registerSemanticContributor(contributor);
  }

  return registry;
}

function createDefaultLanguageResolvers(): ILanguageResolver[] {
  const importResolver: ILanguageResolver = {
    async resolve(graph, rootPath, report) {
      const counts = await addImportResolutionRelationships(graph, rootPath, report);
      report.resolvedImports = counts.resolved;
      report.unresolvedRelativeImports = counts.unresolved;
    },
  };

  const packageImportResolver: ILanguageResolver = {
    resolve(graph) {
      addImportPackageRelationships(graph);
    },
  };

  const inheritanceResolver: ILanguageResolver = {
    resolve(graph) {
      addInheritanceRelationships(graph);
    },
  };

  const callResolver: ILanguageResolver = {
    resolve(graph) {
      addCallResolutionRelationships(graph);
    },
  };

  return [importResolver, packageImportResolver, inheritanceResolver, callResolver];
}

export const coreIntegrationRegistry = createDefaultCoreIntegrationRegistry();
