/**
 * Graph schema: node tables, relationship tables and their typed properties.
 * Every node also has a STRING `id` primary key. The store validates writes
 * against this schema and the Cypher binder resolves names against it.
 */

/** Bump when tables or properties change; scans of an older version are rewritten, never patched. */
export const SCHEMA_VERSION = 53;

export type PropertyType = "STRING" | "INT64" | "BOOLEAN";

export type NodeTable = {
  label: string;
  properties: Readonly<Record<string, PropertyType>>;
};

export type RelationshipTable = {
  type: string;
  from: string;
  to: string;
  properties: Readonly<Record<string, PropertyType>>;
};

export const nodeTables: readonly NodeTable[] = [
  { label: "Repo", properties: { path: "STRING", name: "STRING" } },
  { label: "Package", properties: { path: "STRING", relativePath: "STRING", name: "STRING", version: "STRING", isPrivate: "BOOLEAN", manager: "STRING", workspaceRoot: "BOOLEAN" } },
  { label: "Directory", properties: { path: "STRING", relativePath: "STRING", name: "STRING" } },
  { label: "File", properties: { path: "STRING", relativePath: "STRING", language: "STRING", defaultExport: "STRING", defaultExportFrom: "STRING", sourceType: "STRING", isTest: "BOOLEAN", isFixture: "BOOLEAN", isSupport: "BOOLEAN", isGenerated: "BOOLEAN" } },
  { label: "Import", properties: { source: "STRING", specifier: "STRING", line: "INT64", isReExport: "BOOLEAN", isWildcard: "BOOLEAN", isDynamic: "BOOLEAN", isCjs: "BOOLEAN", isTypeOnly: "BOOLEAN", bindings: "STRING" } },
  { label: "Function", properties: { name: "STRING", kind: "STRING", methodKind: "STRING", line: "INT64", endLine: "INT64", className: "STRING", isExported: "BOOLEAN", isAsync: "BOOLEAN", isAbstract: "BOOLEAN", visibility: "STRING", parameters: "STRING", returnType: "STRING" } },
  { label: "Class", properties: { name: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN", isAbstract: "BOOLEAN", visibility: "STRING", extendsNames: "STRING", implementsNames: "STRING" } },
  { label: "Interface", properties: { name: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN" } },
  { label: "TypeAlias", properties: { name: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN" } },
  { label: "Enum", properties: { name: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN" } },
  { label: "Call", properties: { name: "STRING", expression: "STRING", callee: "STRING", receiver: "STRING", requireSource: "STRING", line: "INT64", columnNumber: "INT64", args: "STRING", httpClient: "STRING", httpReceiver: "STRING", httpMethod: "STRING", httpUrl: "STRING" } },
  { label: "Field", properties: { name: "STRING", typeName: "STRING", isStatic: "BOOLEAN", isReadonly: "BOOLEAN", visibility: "STRING", line: "INT64", isInjected: "BOOLEAN" } },
  { label: "Variable", properties: { name: "STRING", kind: "STRING", isExported: "BOOLEAN", line: "INT64", stringValue: "STRING", stringTemplate: "STRING", httpClient: "STRING", httpBaseUrl: "STRING", trpcRouter: "BOOLEAN", trpcMounts: "STRING" } },
  { label: "Decorator", properties: { name: "STRING", expression: "STRING", line: "INT64", args: "STRING" } },
  { label: "Route", properties: { method: "STRING", path: "STRING", fullPath: "STRING", pathExpression: "STRING", receiverName: "STRING", line: "INT64", framework: "STRING", handlerName: "STRING", pendingHandlerRefs: "STRING", scopeFunctionId: "STRING" } },
  { label: "EntryPoint", properties: { kind: "STRING", trigger: "STRING", receiverName: "STRING", library: "STRING", line: "INT64", handlerName: "STRING" } },
  { label: "EnvVar", properties: { name: "STRING", isPublic: "BOOLEAN" } },
  { label: "Page", properties: { path: "STRING", fullPath: "STRING", framework: "STRING", router: "STRING", kind: "STRING", slot: "STRING", line: "INT64", component: "STRING" } },
  { label: "Component", properties: { name: "STRING", framework: "STRING", kind: "STRING", tagName: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN", pendingRenders: "STRING", hooks: "STRING", lazySource: "STRING", lazyExport: "STRING", defaultExportWrapper: "STRING" } },
  { label: "ConfigValue", properties: { name: "STRING", value: "STRING", valueType: "STRING", line: "INT64" } },
  { label: "DataModel", properties: { name: "STRING", library: "STRING", declaredIn: "STRING", line: "INT64" } },
  { label: "Table", properties: { name: "STRING", kind: "STRING", library: "STRING", schemaName: "STRING", provider: "STRING", declaredIn: "STRING", line: "INT64", columns: "STRING" } },
];

export const relationshipTables: readonly RelationshipTable[] = [
  { type: "CONTAINS_ROOT", from: "Repo", to: "Directory", properties: {} },
  { type: "HAS_PACKAGE", from: "Repo", to: "Package", properties: {} },
  { type: "CONTAINS_DIRECTORY", from: "Directory", to: "Directory", properties: {} },
  { type: "CONTAINS_FILE", from: "Directory", to: "File", properties: {} },
  { type: "PACKAGE_CONTAINS_FILE", from: "Package", to: "File", properties: {} },
  { type: "PACKAGE_DECLARES_CONFIG", from: "Package", to: "ConfigValue", properties: {} },
  { type: "PACKAGE_IMPORTS_PACKAGE", from: "Package", to: "Package", properties: { dependencyType: "STRING" } },
  { type: "IMPORTS_PACKAGE", from: "Import", to: "Package", properties: {} },
  { type: "IMPORTS", from: "File", to: "Import", properties: {} },
  { type: "RESOLVES_TO", from: "Import", to: "File", properties: {} },
  { type: "DEFINES_FUNCTION", from: "File", to: "Function", properties: {} },
  { type: "DEFINES_CLASS", from: "File", to: "Class", properties: {} },
  { type: "DEFINES_INTERFACE", from: "File", to: "Interface", properties: {} },
  { type: "DEFINES_TYPE_ALIAS", from: "File", to: "TypeAlias", properties: {} },
  { type: "DEFINES_ENUM", from: "File", to: "Enum", properties: {} },
  { type: "DEFINES_METHOD", from: "Class", to: "Function", properties: {} },
  { type: "DEFINES_FIELD", from: "Class", to: "Field", properties: {} },
  { type: "DEFINES_VARIABLE", from: "File", to: "Variable", properties: {} },
  { type: "HAS_DECORATOR", from: "Class", to: "Decorator", properties: {} },
  { type: "HAS_METHOD_DECORATOR", from: "Function", to: "Decorator", properties: {} },
  { type: "EXTENDS", from: "Class", to: "Class", properties: {} },
  { type: "IMPLEMENTS", from: "Class", to: "Interface", properties: {} },
  { type: "RE_EXPORTS", from: "File", to: "Import", properties: {} },
  { type: "RE_EXPORTS_FUNCTION", from: "File", to: "Function", properties: {} },
  { type: "RE_EXPORTS_CLASS", from: "File", to: "Class", properties: {} },
  { type: "RE_EXPORTS_VARIABLE", from: "File", to: "Variable", properties: {} },
  { type: "CALLS", from: "Function", to: "Call", properties: {} },
  { type: "CALL_RESOLVES_TO", from: "Call", to: "Function", properties: {} },
  { type: "MODULE_CALLS", from: "File", to: "Call", properties: {} },
  { type: "PASSED_TO", from: "Function", to: "Call", properties: {} },
  { type: "INITIALIZED_BY", from: "Variable", to: "Call", properties: {} },
  { type: "DECLARES_ROUTE", from: "File", to: "Route", properties: {} },
  { type: "ROUTE_HANDLED_BY", from: "Route", to: "Function", properties: {} },
  { type: "DECLARES_ENTRYPOINT", from: "File", to: "EntryPoint", properties: {} },
  { type: "ENTRYPOINT_HANDLED_BY", from: "EntryPoint", to: "Function", properties: {} },
  { type: "DECLARES_COMPONENT", from: "File", to: "Component", properties: {} },
  { type: "DECLARES_PAGE", from: "File", to: "Page", properties: {} },
  { type: "PAGE_RENDERS", from: "Page", to: "Component", properties: {} },
  { type: "REQUESTS", from: "Call", to: "Route", properties: { method: "STRING", url: "STRING", match: "STRING" } },
  { type: "COMPONENT_DEFINED_BY", from: "Component", to: "Class", properties: {} },
  { type: "COMPONENT_DEFINED_BY_FUNCTION", from: "Component", to: "Function", properties: {} },
  { type: "RENDERS", from: "Component", to: "Component", properties: { props: "STRING", line: "INT64" } },
  { type: "USES_HOOK", from: "Function", to: "Function", properties: { line: "INT64" } },
  { type: "USES_CONTEXT", from: "Function", to: "Component", properties: { line: "INT64" } },
  { type: "ROUTE_LIFECYCLE_STEP", from: "Route", to: "Function", properties: { role: "STRING", scope: "STRING", hook: "STRING", orderIndex: "INT64" } },
  { type: "LIFECYCLE_PRECEDES", from: "Function", to: "Function", properties: { routeId: "STRING", scope: "STRING", orderIndex: "INT64" } },
  { type: "MOUNTS_VARIABLE", from: "Variable", to: "Variable", properties: { path: "STRING", pathExpression: "STRING", line: "INT64" } },
  { type: "MOUNTS_FUNCTION", from: "Variable", to: "Function", properties: { path: "STRING", pathExpression: "STRING", line: "INT64" } },
  { type: "MODULE_IMPORTS", from: "Class", to: "Class", properties: {} },
  { type: "MODULE_PROVIDES", from: "Class", to: "Class", properties: {} },
  { type: "MODULE_CONTROLS", from: "Class", to: "Class", properties: {} },
  { type: "MODULE_EXPORTS", from: "Class", to: "Class", properties: {} },
  { type: "INJECTS", from: "Class", to: "Class", properties: { fieldName: "STRING" } },
  { type: "USES_ENV_FILE", from: "File", to: "EnvVar", properties: { line: "INT64", access: "STRING" } },
  { type: "USES_ENV_FUNCTION", from: "Function", to: "EnvVar", properties: { line: "INT64", access: "STRING" } },
  { type: "USES_ENV_ROUTE", from: "Route", to: "EnvVar", properties: { line: "INT64", access: "STRING" } },
  { type: "DECLARES_CONFIG_FILE", from: "File", to: "ConfigValue", properties: {} },
  { type: "DECLARES_CONFIG_REPO", from: "Repo", to: "ConfigValue", properties: {} },
  { type: "CONSUMES_CONFIG_FILE", from: "File", to: "ConfigValue", properties: { localName: "STRING" } },
  { type: "CONSUMES_CONFIG_FUNCTION", from: "Function", to: "ConfigValue", properties: { localName: "STRING" } },
  { type: "CONSUMES_CONFIG_ROUTE", from: "Route", to: "ConfigValue", properties: { localName: "STRING" } },
  { type: "ACCESSES_DATA_FILE", from: "File", to: "DataModel", properties: { operation: "STRING", library: "STRING", line: "INT64", expression: "STRING" } },
  { type: "ACCESSES_DATA_FUNCTION", from: "Function", to: "DataModel", properties: { operation: "STRING", library: "STRING", line: "INT64", expression: "STRING" } },
  { type: "ACCESSES_DATA_ROUTE", from: "Route", to: "DataModel", properties: { operation: "STRING", library: "STRING", line: "INT64", expression: "STRING" } },
  { type: "ACCESSES_DATA_ENTRYPOINT", from: "EntryPoint", to: "DataModel", properties: { operation: "STRING", library: "STRING", line: "INT64", expression: "STRING" } },
  { type: "MAPS_TO_TABLE", from: "DataModel", to: "Table", properties: {} },
  { type: "RELATES_TO", from: "DataModel", to: "DataModel", properties: { field: "STRING", kind: "STRING", fields: "STRING", references: "STRING", relationName: "STRING", onDelete: "STRING" } },
  { type: "READS_FILE", from: "File", to: "Table", properties: { operation: "STRING", line: "INT64", expression: "STRING", model: "STRING" } },
  { type: "READS_FUNCTION", from: "Function", to: "Table", properties: { operation: "STRING", line: "INT64", expression: "STRING", model: "STRING" } },
  { type: "READS_ROUTE", from: "Route", to: "Table", properties: { operation: "STRING", line: "INT64", expression: "STRING", model: "STRING" } },
  { type: "READS_ENTRYPOINT", from: "EntryPoint", to: "Table", properties: { operation: "STRING", line: "INT64", expression: "STRING", model: "STRING" } },
  { type: "WRITES_FILE", from: "File", to: "Table", properties: { operation: "STRING", line: "INT64", expression: "STRING", model: "STRING" } },
  { type: "WRITES_FUNCTION", from: "Function", to: "Table", properties: { operation: "STRING", line: "INT64", expression: "STRING", model: "STRING" } },
  { type: "WRITES_ROUTE", from: "Route", to: "Table", properties: { operation: "STRING", line: "INT64", expression: "STRING", model: "STRING" } },
  { type: "WRITES_ENTRYPOINT", from: "EntryPoint", to: "Table", properties: { operation: "STRING", line: "INT64", expression: "STRING", model: "STRING" } },
];

/** Node labels in `graph_stats` order. */
export const nodeLabels = [
  "Repo",
  "Package",
  "Directory",
  "File",
  "Import",
  "Function",
  "Class",
  "Field",
  "Variable",
  "Decorator",
  "Interface",
  "TypeAlias",
  "Enum",
  "Call",
  "Route",
  "EntryPoint",
  "EnvVar",
  "ConfigValue",
  "DataModel",
  "Table",
  "Component",
  "Page",
] as const;
export const relationshipTypes = relationshipTables.map((table) => table.type);

export const nodeTableByLabel: ReadonlyMap<string, NodeTable> = new Map(nodeTables.map((table) => [table.label, table]));
export const relationshipTableByType: ReadonlyMap<string, RelationshipTable> = new Map(
  relationshipTables.map((table) => [table.type, table]),
);
