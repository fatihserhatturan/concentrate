import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nodeContentHasher, nodeFileSystem } from "../adapters/fs/node-file-system.js";
import { ParseCache } from "../adapters/fs/parse-cache.js";
import { buildCodeGraph as coreBuildCodeGraph, createScanOrchestrator, type ScanDependencies } from "../core/scan/orchestrator.js";
import { coreIntegrationRegistry, createLanguageTable, defaultLanguageTable, CoreIntegrationRegistry } from "./default-registry.js";
import type { RegistryModuleSpecifier } from "../core/integrations/registry-module.js";
import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "../core/scan/result.js";
import { parserFingerprint } from "./parser-fingerprint.js";
import { autoParseWorkers, createParserPool, defaultRegistryModule } from "./parser-pool.js";
import { collectGarbageAfterGrowth } from "./garbage.js";

export type ScanDependenciesOptions = {
  // The module worker threads build `registry` from (core/integrations/registry-module.ts).
  // It must build a registry equivalent to `registry`. Without it a custom
  // registry parses on the main thread; the default registry always has one.
  registryModule?: RegistryModuleSpecifier;
};

// What a scan needs, from `registry` and its languages. Workers rebuild the
// registry from a registry module, so only the default registry and a registry
// given its `registryModule` parse on worker threads.
export function createScanDependencies(
  registry: CoreIntegrationRegistry = coreIntegrationRegistry,
  options: ScanDependenciesOptions = {},
): ScanDependencies {
  const isDefault = registry === coreIntegrationRegistry;
  const registryModule = options.registryModule !== undefined
    ? registryModuleHref(options.registryModule)
    : isDefault ? defaultRegistryModule : undefined;
  return {
    fileSystem: nodeFileSystem,
    hasher: nodeContentHasher,
    languages: isDefault ? defaultLanguageTable : createLanguageTable(registry),
    getParser: (language: string) => registry.getLanguageParser(language),
    // Read through the registry on every access: it can still change, and contributors are ordered on demand.
    get resolvers() { return registry.languageResolvers; },
    get contributors() { return registry.semanticContributors; },
    manifestReaders: registry.projectManifestReaders,
    parserFingerprint: () => parserFingerprint(registry),
    ...(registryModule !== undefined
      ? { createParserPool: (size: number) => createParserPool(size, undefined, { registry, registryModule }), autoParseWorkers }
      : {}),
    collectGarbage: collectGarbageAfterGrowth,
    createParseCache: (directory, rootPath, fingerprint, report) => new ParseCache(directory, rootPath, fingerprint, report),
    parallelism: os.availableParallelism(),
  };
}

// A `file:` URL string for workers to import: an absolute path or URL becomes
// one; a bare package specifier is kept as written.
function registryModuleHref(specifier: RegistryModuleSpecifier): string {
  if (specifier instanceof URL) return specifier.href;
  if (/^[a-z][a-z\d+.-]+:/iu.test(specifier)) return specifier;
  return path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
}

const deps = createScanDependencies();

export const scanOrchestrator = createScanOrchestrator(deps);

// Scans with the default registry, or with `scanner`: another registry (parsed
// on the main thread) or the dependencies made by createScanDependencies.
export function buildCodeGraph(
  projectPath: string,
  options: BuildCodeGraphOptions,
  scanner?: CoreIntegrationRegistry | ScanDependencies,
): Promise<BuildCodeGraphResult> {
  const scanDependencies = scanner === undefined
    ? deps
    : scanner instanceof CoreIntegrationRegistry ? createScanDependencies(scanner) : scanner;
  return coreBuildCodeGraph(projectPath, options, scanDependencies);
}
