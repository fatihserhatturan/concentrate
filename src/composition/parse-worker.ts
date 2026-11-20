import { parentPort, workerData } from "node:worker_threads";
import type { CoreIntegrationRegistry } from "../core/integrations/registry.js";
import type { IRegistryModule } from "../core/integrations/registry-module.js";
import type { SupportedLanguage } from "../core/scan/language.js";

// Worker thread of the parser pool (parser-pool.ts): parses one file per
// message with the language parsers of the registry the scan uses. The pool
// passes the registry module (core/integrations/registry-module.ts) in
// workerData; the worker builds the registry from it once. A module that
// fails to load fails the worker, and the pool parses on the main thread.

export type ParseRequest = { id: number; language: SupportedLanguage; rootPath: string; filePath: string };
export type ParseResponse =
  | { id: number; ok: true; parsed: unknown }
  | { id: number; ok: false; message: string };
export type ParseWorkerData = { registryModule: string };

const runningFromSources = import.meta.url.endsWith(".ts");

// Under tsx a dynamic import() in a worker does not map the `.js` specifiers of
// TypeScript sources, so the module goes through tsx's own loader there.
async function importModule(specifier: string): Promise<Partial<IRegistryModule>> {
  if (!runningFromSources) return await import(specifier) as Partial<IRegistryModule>;
  // tsx is a dev dependency (only sources run under it), so it is resolved by name at run time.
  const { tsImport } = await import(import.meta.resolve("tsx/esm/api")) as { tsImport(specifier: string, parent: string): Promise<unknown> };
  return await tsImport(specifier, import.meta.url) as Partial<IRegistryModule>;
}

async function loadRegistry(specifier: string): Promise<CoreIntegrationRegistry> {
  const loaded = await importModule(specifier);
  if (typeof loaded.createRegistry !== "function") {
    throw new Error(`Registry module ${specifier} does not export createRegistry()`);
  }
  return await loaded.createRegistry();
}

const registry = loadRegistry((workerData as ParseWorkerData).registryModule);

parentPort!.on("message", async ({ id, language, rootPath, filePath }: ParseRequest) => {
  // Outside the try: a registry that cannot be built ends the worker.
  const parsers = await registry;
  let response: ParseResponse;
  try {
    const parsed = await parsers.getLanguageParser(language).parse(rootPath, filePath);
    response = { id, ok: true, parsed };
  } catch (error) {
    response = { id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  parentPort!.postMessage(response);
});
