import { GraphStore, type GraphStoreOpenOptions } from "../../src/adapters/store/store.js";
import { defaultGraphSchema } from "../../src/composition/default-schema.js";

// A graph store with the default integrations' schema, as the default scan writes it.
export function openTestStore(directory: string, options: Partial<GraphStoreOpenOptions> = {}): Promise<GraphStore> {
  return GraphStore.open(directory, { schema: defaultGraphSchema, ...options });
}
