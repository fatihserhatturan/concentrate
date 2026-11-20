import type { GraphSchemaExtension } from "../../../core/graph/schema.js";

// C/C++ properties: scope, system includes, virtual/override/declaration flags and call argument counts.
export const cppGraphSchema: GraphSchemaExtension = {
  id: "cpp-language",
  nodeProperties: [
    { label: "File", after: "allNames", properties: { cppScope: "STRING" } },
    { label: "Import", after: "isModule", properties: { isSystem: "BOOLEAN" } },
    { label: "Function", after: "qualifiedName", properties: { isVirtual: "BOOLEAN", isOverride: "BOOLEAN", isDeclaration: "BOOLEAN" } },
    { label: "Call", after: "qualifier", properties: { argCount: "INT64" } },
  ],
};
