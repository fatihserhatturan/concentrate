import { createDefaultCoreIntegrationRegistry } from "./default-registry.js";

// The registry module (see core/integrations/registry-module.ts) of the
// default registry: parser workers import it unless the scan names another.
export function createRegistry() {
  return createDefaultCoreIntegrationRegistry();
}
