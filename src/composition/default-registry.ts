import { addImportResolutionRelationships } from "../integrations/resolution/imports.js";
import { addImportPackageRelationships } from "../core/scan/workspace-packages.js";
import { addCallResolutionRelationships } from "../core/scan/resolution/calls.js";
import { addInheritanceRelationships } from "../core/scan/resolution/inheritance.js";
import { astroParser, htmlParser, javascriptParser, svelteParser, typescriptParser, vueParser } from "../integrations/frameworks/js-ts/scanner.js";
import { goDataAccessContributor, goDiContributor, goEntrypointsContributor, goEnvConfigContributor, goForeignRoutersContributor, goFrameworkParser, goGrpcContributor, goHttpClientsContributor, goRoutesContributor } from "../integrations/frameworks/go/index.js";
import { rustEnvConfigContributor, rustDataAccessContributor, rustHttpClientsContributor, rustEntrypointsContributor, rustFrameworkParser, rustRoutesContributor } from "../integrations/frameworks/rust/index.js";
import { pythonEntrypointsContributor, pythonFrameworkParser, pythonRoutesContributor } from "../integrations/frameworks/python/index.js";
import { plainFileParsers } from "../integrations/languages/plain/parser.js";
import { protoContributor } from "../integrations/frameworks/proto/index.js";
import { sqlSchemaContributor } from "../integrations/frameworks/sql/index.js";
import { stylesContributor } from "../integrations/frameworks/styles/index.js";
import { scriptsContributor } from "../integrations/frameworks/scripts/index.js";
import { cFrameworkParser, cppFrameworkParser, cppBuildContributor, cppRoutesContributor, cppEnvConfigContributor, cppDataAccessContributor, cppGrpcContributor, cppQtContributor } from "../integrations/frameworks/cpp/index.js";
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
import { navigationContributor } from "../integrations/frameworks/js-ts/resolution/navigation.js";
import { trpcRoutesContributor } from "../integrations/frameworks/js-ts/resolution/trpc-routes.js";
import type { ILanguageResolver } from "../core/contracts/language-resolver.js";
import { CoreIntegrationRegistry } from "../core/integrations/registry.js";

import { cppLanguages } from "../integrations/languages/cpp/descriptor.js";
import { goLanguages } from "../integrations/languages/go/descriptor.js";
import { jsTsLanguages } from "../integrations/languages/js-ts/descriptor.js";
import { plainLanguages } from "../integrations/languages/plain/descriptor.js";
import { pythonLanguages } from "../integrations/languages/python/descriptor.js";
import { rustLanguages } from "../integrations/languages/rust/descriptor.js";
import { jsTsManifestReader } from "../integrations/languages/js-ts/project.js";
import { pythonManifestReader } from "../integrations/languages/python/project.js";
import { javaManifestReader } from "../integrations/languages/java/project.js";
import { LanguageTable } from "../core/scan/language.js";
import { cppCallResolver, cppInheritanceResolver } from "../integrations/languages/cpp/resolvers.js";
import { goCallResolver, goInheritanceResolver } from "../integrations/languages/go/resolvers.js";
import { pythonCallResolver, pythonInheritanceResolver } from "../integrations/languages/python/resolvers.js";
import { javaCallResolver, javaInheritanceResolver } from "../integrations/languages/java/resolvers.js";
import { styleImportResolver, protoImportResolver } from "../integrations/languages/plain/import-resolver.js";
import { rustImportResolver } from "../integrations/languages/rust/import-resolver.js";
import { cppImportResolver } from "../integrations/languages/cpp/import-resolver.js";
import { pythonImportResolver } from "../integrations/languages/python/import-resolver.js";
import { javaImportResolver } from "../integrations/languages/java/import-resolver.js";
import { goImportResolver } from "../integrations/languages/go/import-resolver.js";
import { jsTsImportResolver } from "../integrations/languages/js-ts/import-resolver.js";
import { rustCallResolver, rustInheritanceResolver } from "../integrations/languages/rust/resolvers.js";

import { cppUnusedRules } from "../integrations/languages/cpp/unused.js";
import { javaUnusedRules } from "../integrations/languages/java/unused.js";
import { javaBuildContributor, javaConfigEnvContributor, javaDataJdbcContributor, javaDataJpaContributor, javaDiContributor, javaHttpClientsContributor, javaEntrypointsContributor, javaFrameworkEntrypointsContributor, javaFrameworkParser, javaGrpcContributor, javaRoutesContributor, javaTestsContributor, javaWebfluxContributor } from "../integrations/frameworks/java/index.js";
import { goUnusedRules } from "../integrations/languages/go/unused.js";
import { jsTsUnusedRules } from "../integrations/languages/js-ts/unused.js";
import { pythonUnusedRules } from "../integrations/languages/python/unused.js";
import { rustUnusedRules } from "../integrations/languages/rust/unused.js";

import { jsTsGraphSchema } from "../integrations/frameworks/js-ts/schema.js";
import { cppBuildGraphSchema } from "../integrations/frameworks/cpp/schema.js";
import { cppGraphSchema } from "../integrations/languages/cpp/schema.js";
import { javaGraphSchema } from "../integrations/languages/java/schema.js";
import { javaLanguages } from "../integrations/languages/java/descriptor.js";
import { goGraphSchema } from "../integrations/languages/go/schema.js";
import { rustGraphSchema } from "../integrations/languages/rust/schema.js";

export { CoreIntegrationRegistry };

export function createDefaultCoreIntegrationRegistry(): CoreIntegrationRegistry {
  const registry = new CoreIntegrationRegistry();

  // Plain languages first: a file name or extension a later descriptor also claims goes to the later one.
  for (const descriptor of [...plainLanguages, ...jsTsLanguages, ...pythonLanguages, ...goLanguages, ...rustLanguages, ...cppLanguages, ...javaLanguages]) {
    registry.registerLanguage(descriptor);
  }

  // Graph properties each integration adds to the core tables. Rust before C/C++: both add Import
  // properties after `isModule`, and the merged order must stay what the closed schema had.
  for (const extension of [jsTsGraphSchema, goGraphSchema, rustGraphSchema, cppGraphSchema, cppBuildGraphSchema, javaGraphSchema]) {
    registry.registerGraphSchema(extension);
  }

  for (const parser of [javascriptParser, typescriptParser, htmlParser, vueParser, svelteParser, astroParser, pythonFrameworkParser, goFrameworkParser, rustFrameworkParser, cFrameworkParser, cppFrameworkParser, javaFrameworkParser, ...plainFileParsers]) {
    registry.registerLanguageParser(parser);
  }

  for (const resolver of [cppCallResolver, goCallResolver, rustCallResolver, pythonCallResolver, javaCallResolver]) {
    registry.registerCallResolver(resolver);
  }

  // The first that supports an importing file resolves its imports.
  for (const resolver of [styleImportResolver, protoImportResolver, rustImportResolver, cppImportResolver, pythonImportResolver, goImportResolver, javaImportResolver, jsTsImportResolver]) {
    registry.registerImportResolver(resolver);
  }

  for (const resolver of [goInheritanceResolver, cppInheritanceResolver, pythonInheritanceResolver, rustInheritanceResolver, javaInheritanceResolver]) {
    registry.registerInheritanceResolver(resolver);
  }

  // js-ts first: it owns a directory that has both a package.json and a pyproject.toml; Java comes last.
  for (const reader of [jsTsManifestReader, pythonManifestReader, javaManifestReader]) {
    registry.registerProjectManifestReader(reader);
  }

  // The order is the order of the find_unused_exports note's language paragraphs.
  for (const rules of [jsTsUnusedRules, goUnusedRules, rustUnusedRules, pythonUnusedRules, cppUnusedRules, javaUnusedRules]) {
    registry.registerUnusedExportRules(rules);
  }

  for (const resolver of createDefaultLanguageResolvers(registry)) {
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
    rustEnvConfigContributor,
    rustDataAccessContributor,
    rustHttpClientsContributor,
    cppRoutesContributor,
    cppGrpcContributor,
    cppQtContributor,
    cppEnvConfigContributor,
    cppDataAccessContributor,
    pythonRoutesContributor,
    pythonEntrypointsContributor,
    javaEntrypointsContributor,
    javaFrameworkEntrypointsContributor,
    javaRoutesContributor,
    javaWebfluxContributor,
    javaGrpcContributor,
    javaTestsContributor,
    javaDiContributor,
    // Before js-ts.data-access (READS / WRITES from their accesses), js-ts.http-requests (REQUESTS) and js-ts.env-config / env-files.
    javaDataJpaContributor,
    javaDataJdbcContributor,
    javaConfigEnvContributor,
    javaHttpClientsContributor,
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
    cppBuildContributor,
    javaBuildContributor,
    stylesContributor,
    dataAccessContributor,
    nuxtAutoImportsContributor,
    storeAccessContributor,
    componentGraphContributor,
    angularTemplatesContributor,
    vueGlobalComponentsContributor,
    nextjsPagesContributor,
    nuxtPagesContributor,
    navigationContributor,
    // Declares dependsOn every contributor that makes Table nodes: SQL files merge into them by name.
    sqlSchemaContributor,
    protoContributor,
  ]) {
    registry.registerSemanticContributor(contributor);
  }

  return registry;
}

function createDefaultLanguageResolvers(registry: CoreIntegrationRegistry): ILanguageResolver[] {
  const importResolver: ILanguageResolver = {
    id: "core.imports",
    async resolve(graph, rootPath, report) {
      const counts = await addImportResolutionRelationships(graph, rootPath, registry.importResolvers, report);
      report.resolvedImports = counts.resolved;
      report.unresolvedRelativeImports = counts.unresolved;
    },
  };

  const packageImportResolver: ILanguageResolver = {
    id: "core.package-imports",
    resolve(graph) {
      addImportPackageRelationships(graph);
    },
  };

  const inheritanceResolver: ILanguageResolver = {
    id: "core.inheritance",
    resolve(graph) {
      addInheritanceRelationships(graph, registry.inheritanceResolvers);
    },
  };

  const callResolver: ILanguageResolver = {
    id: "core.calls",
    resolve(graph) {
      addCallResolutionRelationships(graph, registry.callResolvers);
    },
  };

  return [importResolver, packageImportResolver, inheritanceResolver, callResolver];
}

// The scan's languages of a registry: its descriptors, in registration order.
export function createLanguageTable(registry: CoreIntegrationRegistry): LanguageTable {
  return new LanguageTable(registry.languages);
}

export const coreIntegrationRegistry = createDefaultCoreIntegrationRegistry();
export const defaultLanguageTable = createLanguageTable(coreIntegrationRegistry);
