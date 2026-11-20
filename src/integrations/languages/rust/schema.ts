import type { GraphSchemaExtension } from "../../../core/graph/schema.js";

// Rust properties: the crate and module a file belongs to, inline modules, `#[path]` attributes and implemented traits.
export const rustGraphSchema: GraphSchemaExtension = {
  id: "rust-language",
  nodeProperties: [
    { label: "File", after: "packageName", properties: { rustCrate: "STRING", rustCrateName: "STRING", rustModule: "STRING" } },
    { label: "Import", after: "isModule", properties: { inlineModules: "STRING", pathAttribute: "STRING" } },
    { label: "Function", after: "testKind", properties: { implementsTrait: "STRING" } },
  ],
};
