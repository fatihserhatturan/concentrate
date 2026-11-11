import { addImportResolutionRelationships } from "../integrations/resolution/imports.js";
import { addImportPackageRelationships } from "../core/scan/workspace-packages.js";
import { addCallResolutionRelationships } from "../core/scan/resolution/calls.js";
import { addInheritanceRelationships } from "../core/scan/resolution/inheritance.js";
import { astroParser, htmlParser, javascriptParser, svelteParser, typescriptParser, vueParser } from "../integrations/frameworks/js-ts/scanner.js";
import { pythonParser } from "../integrations/languages/python/parser.js";
import { goDataAccessContributor, goDiContributor, goEntrypointsContributor, goEnvConfigContributor, goForeignRoutersContributor, goFrameworkParser, goGrpcContributor, goHttpClientsContributor, goRoutesContributor } from "../integrations/frameworks/go/index.js";
import { rustDataAccessContributor, rustHttpClientsContributor, rustEntrypointsContributor, rustFrameworkParser, rustRoutesContributor } from "../integrations/frameworks/rust/index.js";
import { plainFileParsers } from "../integrations/languages/plain/parser.js";
import { protoContributor } from "../integrations/frameworks/proto/index.js";
import { sqlSchemaContributor } from "../integrations/frameworks/sql/index.js";
import { stylesContributor } from "../integrations/frameworks/styles/index.js";
import { scriptsContributor } from "../integrations/frameworks/scripts/index.js";
import {
  nestjsModulesContributor,
  nestjsInjectionContributor,
  instanceMethodContributor,
} from "../integrations/frameworks/js-ts/nestjs.js";
import { routePathContributor } from "../integrations/frameworks/js-ts/fastify.js";
import { routeHandlerContributor } from "../integrations/frameworks/js-ts/express-koa.js";
import { envConfigContributor } from "../integrations/frameworks/js-ts/env-config.js";
import { envFilesContributor } from "../integrations/frameworks/js-ts/env-files.js";
import { dataAccessContributor } from "../integrations/frameworks/js-ts/data-access.js";
import { componentGraphContributor } from "../integrations/frameworks/js-ts/resolution/component-graph.js";
import { nextjsPagesContributor, nextjsRoutesContributor } from "../integrations/frameworks/js-ts/nextjs.js";
import { svelteKitContributor } from "../integrations/frameworks/js-ts/sveltekit.js";
import { astroPagesContributor } from "../integrations/frameworks/js-ts/astro.js";
import { angularTemplatesContributor } from "../integrations/frameworks/js-ts/angular.js";
import { angularRouteMountsContributor } from "../integrations/frameworks/js-ts/angular-router.js";
import { nuxtAutoImportsContributor, nuxtPagesContributor, nuxtServerRoutesContributor, vueGlobalComponentsContributor } from "../integrations/frameworks/js-ts/nuxt.js";
import { storeAccessContributor } from "../integrations/frameworks/js-ts/resolution/store-access.js";
import { httpRequestsContributor } from "../integrations/frameworks/js-ts/resolution/http-requests.js";
import { trpcRoutesContributor } from "../integrations/frameworks/js-ts/resolution/trpc-routes.js";
import type { ILanguageResolver } from "../core/contracts/language-resolver.js";
import { CoreIntegrationRegistry } from "../core/integrations/registry.js";

export { CoreIntegrationRegistry };

export function createDefaultCoreIntegrationRegistry(): CoreIntegrationRegistry {
  const registry = new CoreIntegrationRegistry();

  for (const parser of [javascriptParser, typescriptParser, htmlParser, vueParser, svelteParser, astroParser, pythonParser, goFrameworkParser, rustFrameworkParser, ...plainFileParsers]) {
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
    goForeignRoutersContributor,
    goRoutesContributor,
    goEntrypointsContributor,
    goEnvConfigContributor,
    goDataAccessContributor,
    goHttpClientsContributor,
    goDiContributor,
    goGrpcContributor,
    rustRoutesContributor,
    rustEntrypointsContributor,
    rustDataAccessContributor,
    rustHttpClientsContributor,
    nextjsRoutesContributor,
    trpcRoutesContributor,
    nuxtServerRoutesContributor,
    svelteKitContributor,
    astroPagesContributor,
    angularRouteMountsContributor,
    httpRequestsContributor,
    envConfigContributor,
    envFilesContributor,
    scriptsContributor,
    stylesContributor,
    dataAccessContributor,
    nuxtAutoImportsContributor,
    storeAccessContributor,
    componentGraphContributor,
    angularTemplatesContributor,
    vueGlobalComponentsContributor,
    nextjsPagesContributor,
    nuxtPagesContributor,
    // After every contributor that makes Table nodes: SQL files merge into them by name.
    sqlSchemaContributor,
    protoContributor,
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
