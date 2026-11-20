import type { CoreIntegrationRegistry } from "./registry.js";

// A registry module is an ES module that builds the registry of a scan. Worker
// threads import it to get the same registry as the main thread, so a scan
// with a custom registry can parse in parallel too. The module must export
//
//   export function createRegistry(): CoreIntegrationRegistry | Promise<CoreIntegrationRegistry>
//
// and must build an equivalent registry every time it is called (the
// integrations it registers should be deterministic).
export interface IRegistryModule {
  createRegistry(): CoreIntegrationRegistry | Promise<CoreIntegrationRegistry>;
}

// Where a registry module is: a `file:` URL (string or URL) or an absolute path.
export type RegistryModuleSpecifier = string | URL;
