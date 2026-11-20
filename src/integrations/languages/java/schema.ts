import type { GraphSchemaExtension } from "../../../core/graph/schema.js";

// Java properties: file kind and module, nesting of types, static members, parameter counts,
// per-function local types, call kinds and argument counts. Interfaces own their methods and
// constants through their own relationship types; fields can carry annotations.
export const javaGraphSchema: GraphSchemaExtension = {
  id: "java-language",
  nodeProperties: [
    { label: "File", after: "allNames", properties: { javaFileKind: "STRING", javaModule: "STRING" } },
    { label: "Import", after: "isModule", properties: { isStatic: "BOOLEAN" } },
    { label: "Class", after: "qualifiedName", properties: { outer: "STRING", nesting: "STRING", diStereotype: "STRING", diBeanName: "STRING", ambiguousInjections: "INT64" } },
    { label: "Interface", after: "kind", properties: { namespace: "STRING", qualifiedName: "STRING", outer: "STRING", nesting: "STRING" } },
    { label: "Function", after: "qualifiedName", properties: { isStatic: "BOOLEAN", parameterCount: "INT64", javaLocals: "STRING", diBean: "STRING" } },
    { label: "Field", after: "line", properties: { declaredType: "STRING", fieldKind: "STRING" } },
    { label: "Package", after: "workspaceRoot", properties: { buildSystem: "STRING", sourceRoots: "STRING", testSourceRoots: "STRING", aggregator: "BOOLEAN", mainClass: "STRING", mainClassSource: "STRING", buildFile: "STRING" } },
    { label: "EntryPoint", after: "handlerName", properties: { source: "STRING", resolved: "BOOLEAN" } },
    { label: "Call", after: "qualifier", properties: { argumentCount: "INT64", callKind: "STRING" } },
  ],
  relationshipProperties: [{ label: "INJECTS", after: "fieldName", properties: { via: "STRING", beanMethod: "STRING" } }],
  relationshipTables: [
    { type: "DEFINES_INTERFACE_METHOD", from: "Interface", to: "Function", properties: {} },
    { type: "DEFINES_INTERFACE_FIELD", from: "Interface", to: "Field", properties: {} },
    { type: "FIELD_HAS_DECORATOR", from: "Field", to: "Decorator", properties: {} },
  ],
};
