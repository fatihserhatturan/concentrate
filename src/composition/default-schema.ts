import { indexGraphSchema, type GraphSchema, type GraphSchemaIndex } from "../core/graph/schema.js";
import { coreIntegrationRegistry } from "./default-registry.js";

// The graph schema of the default integrations: the core tables plus what each
// integration's schema extension adds.
export const defaultGraphSchema: GraphSchema = coreIntegrationRegistry.graphSchema;
export const defaultGraphSchemaIndex: GraphSchemaIndex = indexGraphSchema(defaultGraphSchema);
