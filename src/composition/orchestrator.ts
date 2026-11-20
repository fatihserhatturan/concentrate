import os from "node:os";
import { nodeContentHasher, nodeFileSystem } from "../adapters/fs/node-file-system.js";
import { ParseCache } from "../adapters/fs/parse-cache.js";
import { buildCodeGraph as coreBuildCodeGraph, createScanOrchestrator, type ScanDependencies } from "../core/scan/orchestrator.js";
import { coreIntegrationRegistry, createLanguageTable, defaultLanguageTable, type CoreIntegrationRegistry } from "./default-registry.js";
import type { BuildCodeGraphOptions, BuildCodeGraphResult } from "../core/scan/result.js";
import { parserFingerprint } from "./parser-fingerprint.js";
import { autoParseWorkers, createParserPool } from "./parser-pool.js";
import { collectGarbageAfterGrowth } from "./garbage.js";

// What a scan needs, from `registry` and its languages. Only the default registry
// can parse on worker threads: workers rebuild it, and with it the same table.
export function createScanDependencies(registry: CoreIntegrationRegistry = coreIntegrationRegistry): ScanDependencies {
  return {
    fileSystem: nodeFileSystem,
    hasher: nodeContentHasher,
    languages: registry === coreIntegrationRegistry ? defaultLanguageTable : createLanguageTable(registry),
    getParser: (language: string) => registry.getLanguageParser(language),
    resolvers: registry.languageResolvers,
    contributors: registry.semanticContributors,
    manifestReaders: registry.projectManifestReaders,
    parserFingerprint,
    ...(registry === coreIntegrationRegistry ? { createParserPool, autoParseWorkers } : {}),
    collectGarbage: collectGarbageAfterGrowth,
    createParseCache: (directory, rootPath, fingerprint, report) => new ParseCache(directory, rootPath, fingerprint, report),
    parallelism: os.availableParallelism(),
  };
}

const deps = createScanDependencies();

export const scanOrchestrator = createScanOrchestrator(deps);

export function buildCodeGraph(
  projectPath: string,
  options: BuildCodeGraphOptions,
): Promise<BuildCodeGraphResult> {
  return coreBuildCodeGraph(projectPath, options, deps);
}
