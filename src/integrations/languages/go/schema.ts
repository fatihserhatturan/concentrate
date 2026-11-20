import type { GraphSchemaExtension } from "../../../core/graph/schema.js";

// Go properties: the declared type and constructor of a variable.
export const goGraphSchema: GraphSchemaExtension = {
  id: "go-language",
  nodeProperties: [
    { label: "Variable", after: "stringTemplate", properties: { goType: "STRING", goConstructor: "STRING" } },
  ],
};
