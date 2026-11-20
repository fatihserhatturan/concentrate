import { GraphStore } from "../adapters/store/store.js";
import type { IGraphStore } from "../core/contracts/graph-store.js";
import type { GraphSchema } from "../core/graph/schema.js";
import { defaultGraphSchema } from "./default-schema.js";

export const GRAPH_SCHEMA_VERSION = defaultGraphSchema.version;

export type OpenGraphStoreOptions = {
  /** Wait for another writer to release the store instead of failing at once. */
  retryLock?: boolean;
  /** The graph schema of the store, normally `registry.graphSchema`. Defaults to the schema of the default integrations. */
  schema?: GraphSchema;
};

// The only place that knows which storage engine backs the graph.
export function openGraphStore(storePath: string, options: OpenGraphStoreOptions = {}): Promise<IGraphStore> {
  return GraphStore.open(storePath, { retryLock: options.retryLock ?? true, schema: options.schema ?? defaultGraphSchema });
}
