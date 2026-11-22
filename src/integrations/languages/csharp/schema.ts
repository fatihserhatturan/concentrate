import type { GraphSchemaExtension } from "../../../core/graph/schema.js";

// C# properties. Types (classes, structs, records, enums and delegates are `Class` nodes told apart by
// `kind`; interfaces are `Interface` nodes) know their namespace, nesting, partial key, generic arity and
// constraints, and the raw base list. Members are `Function` (methods, constructors, operators,
// accessors with code), `Field` (fields, constants, properties, indexers, events, enum members, record
// components). Usings are `Import` nodes with their kind. Calls carry the shape of their receiver.
// Interfaces own their members through the relationship types Java already added; they are declared again
// here (same endpoints) so the extension stands on its own.
export const csharpGraphSchema: GraphSchemaExtension = {
  id: "csharp-language",
  nodeProperties: [
    { label: "File", after: "allNames", properties: { csharpNamespaces: "STRING", csharpPartials: "STRING", hasTopLevelStatements: "BOOLEAN" } },
    {
      label: "Package",
      after: "mainClassSource",
      properties: {
        projectFile: "STRING", sdk: "STRING", outputType: "STRING", executable: "BOOLEAN", rootNamespace: "STRING", assemblyName: "STRING",
        targetFrameworks: "STRING", implicitUsings: "BOOLEAN", usings: "STRING", isTestProject: "BOOLEAN", solutions: "STRING",
      },
    },
    { label: "Import", after: "isModule", properties: { isStatic: "BOOLEAN", importKind: "STRING", isGlobal: "BOOLEAN", usingScope: "STRING", usingScopeStart: "INT64", usingScopeEnd: "INT64", sourceArity: "INT64" } },
    {
      label: "Class",
      after: "qualifiedName",
      properties: {
        outer: "STRING", nesting: "STRING", isPartial: "BOOLEAN", partialKey: "STRING", arity: "INT64", isStatic: "BOOLEAN", isSealed: "BOOLEAN",
        constraints: "STRING", baseNames: "STRING", primaryParameters: "STRING", parameters: "STRING", returnType: "STRING",
      },
    },
    {
      label: "Interface",
      after: "kind",
      properties: {
        namespace: "STRING", qualifiedName: "STRING", outer: "STRING", nesting: "STRING", isPartial: "BOOLEAN", partialKey: "STRING", arity: "INT64",
        constraints: "STRING", baseNames: "STRING", bases: "STRING",
      },
    },
    {
      label: "Function",
      after: "qualifiedName",
      properties: {
        isStatic: "BOOLEAN", parameterCount: "INT64", isVirtual: "BOOLEAN", isOverride: "BOOLEAN", isSealed: "BOOLEAN", isPartial: "BOOLEAN",
        requiredParameterCount: "INT64", hasParams: "BOOLEAN", isExtension: "BOOLEAN", extensionReceiver: "STRING", explicitInterface: "STRING",
        constraints: "STRING", csharpLocals: "STRING", hasBody: "BOOLEAN",
      },
    },
    {
      label: "Field",
      after: "line",
      properties: {
        declaredType: "STRING", fieldKind: "STRING", isAbstract: "BOOLEAN", isVirtual: "BOOLEAN", isOverride: "BOOLEAN", accessors: "STRING",
        explicitInterface: "STRING", parameters: "STRING",
      },
    },
    { label: "Decorator", after: "args", properties: { attributeTarget: "STRING" } },
    {
      label: "Call",
      after: "qualifier",
      properties: { argumentCount: "INT64", argumentTypes: "STRING", callKind: "STRING", receiverKind: "STRING", isConditional: "BOOLEAN", typeArguments: "STRING", typeArity: "INT64", receiverTruncated: "BOOLEAN" },
    },
  ],
  relationshipTables: [
    { type: "DEFINES_INTERFACE_METHOD", from: "Interface", to: "Function", properties: {} },
    { type: "DEFINES_INTERFACE_FIELD", from: "Interface", to: "Field", properties: {} },
    { type: "FIELD_HAS_DECORATOR", from: "Field", to: "Decorator", properties: {} },
  ],
};
