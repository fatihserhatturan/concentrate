/**
 * The graph schema as data: node tables, relationship tables and their typed
 * properties. Every node also has a STRING `id` primary key.
 *
 * Core owns the base schema (the structural vocabulary every scan produces).
 * An integration can extend it with a `GraphSchemaExtension`: new node or
 * relationship tables and extra properties on existing tables. The registry
 * merges the base and all extensions with `mergeGraphSchema`; the store, the
 * Cypher binder and the public API take the merged schema as input, so this
 * file is the single description of what the graph may contain.
 */

/** Bump when the base tables or properties change; scans of an older version are rewritten, never patched. */
export const BASE_SCHEMA_VERSION = 92;

export type PropertyType = "STRING" | "INT64" | "BOOLEAN";

export type PropertyMap = Readonly<Record<string, PropertyType>>;

export type NodeTable = {
  readonly label: string;
  readonly properties: PropertyMap;
};

export type RelationshipTable = {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly properties: PropertyMap;
};

export type GraphSchema = {
  /** The base version; extensions are covered by the store's schema fingerprint, not by this number. */
  readonly version: number;
  readonly nodeTables: readonly NodeTable[];
  readonly relationshipTables: readonly RelationshipTable[];
  /** Node labels in `graph_stats` order. */
  readonly nodeLabels: readonly string[];
};

/** Extra properties for an existing table, kept together and inserted at one place in its property order. */
export type PropertyExtension = {
  /** Label of a node table, or type of a relationship table, to extend. */
  readonly label: string;
  /** Insert after this property; missing or unknown means at the end. Groups after the same property keep registration order. */
  readonly after?: string;
  readonly properties: PropertyMap;
};

export type GraphSchemaExtension = {
  /** Names the extension in merge errors. */
  readonly id: string;
  /** New node tables; their labels join `graph_stats` after the existing ones. */
  readonly nodeTables?: readonly NodeTable[];
  /** New relationship tables; both endpoint labels must exist once every extension is merged. */
  readonly relationshipTables?: readonly RelationshipTable[];
  /** Extra properties on node tables, base or added. */
  readonly nodeProperties?: readonly PropertyExtension[];
  /** Extra properties on relationship tables, base or added; `label` is the relationship type. */
  readonly relationshipProperties?: readonly PropertyExtension[];
};

/** A schema with the lookups the store and the Cypher binder need. */
export type GraphSchemaIndex = GraphSchema & {
  readonly relationshipTypes: readonly string[];
  readonly nodeTableByLabel: ReadonlyMap<string, NodeTable>;
  readonly relationshipTableByType: ReadonlyMap<string, RelationshipTable>;
};

export type CoreNodeLabel = (typeof coreNodeTables)[number]["label"];

const coreNodeTables = [
  { label: "Repo", properties: { path: "STRING", name: "STRING", deprioritize: "STRING" } },
  { label: "Package", properties: { path: "STRING", relativePath: "STRING", name: "STRING", version: "STRING", isPrivate: "BOOLEAN", manager: "STRING", workspaceRoot: "BOOLEAN", unresolved: "INT64" } },
  { label: "Directory", properties: { path: "STRING", relativePath: "STRING", name: "STRING" } },
  { label: "File", properties: { path: "STRING", relativePath: "STRING", language: "STRING", defaultExport: "STRING", defaultExportFrom: "STRING", sourceType: "STRING", isTest: "BOOLEAN", isFixture: "BOOLEAN", isSupport: "BOOLEAN", isGenerated: "BOOLEAN", isDocs: "BOOLEAN", dynamicRouteCalls: "STRING", packageName: "STRING", allNames: "STRING", unresolvedCalls: "STRING" } },
  { label: "Import", properties: { source: "STRING", specifier: "STRING", line: "INT64", isReExport: "BOOLEAN", isWildcard: "BOOLEAN", isDynamic: "BOOLEAN", isCjs: "BOOLEAN", isTypeOnly: "BOOLEAN", bindings: "STRING", alias: "STRING", isModule: "BOOLEAN" } },
  { label: "Function", properties: { name: "STRING", kind: "STRING", methodKind: "STRING", line: "INT64", endLine: "INT64", className: "STRING", isExported: "BOOLEAN", isAsync: "BOOLEAN", isAbstract: "BOOLEAN", visibility: "STRING", parameters: "STRING", returnType: "STRING", typeParameters: "STRING", testKind: "STRING", namespace: "STRING", qualifiedName: "STRING", unresolvedCalls: "STRING" } },
  { label: "Class", properties: { name: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN", isAbstract: "BOOLEAN", visibility: "STRING", extendsNames: "STRING", implementsNames: "STRING", fields: "STRING", typeParameters: "STRING", kind: "STRING", attributes: "STRING", bases: "STRING", namespace: "STRING", qualifiedName: "STRING" } },
  { label: "Interface", properties: { name: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN", methods: "STRING", methodSignatures: "STRING", embeds: "STRING", typeParameters: "STRING", visibility: "STRING", kind: "STRING" } },
  { label: "TypeAlias", properties: { name: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN", aliasOf: "STRING", isAlias: "BOOLEAN", typeParameters: "STRING", visibility: "STRING", namespace: "STRING", qualifiedName: "STRING" } },
  { label: "Enum", properties: { name: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN", variants: "STRING", typeParameters: "STRING", visibility: "STRING", namespace: "STRING", qualifiedName: "STRING" } },
  { label: "Call", properties: { name: "STRING", expression: "STRING", callee: "STRING", receiver: "STRING", requireSource: "STRING", line: "INT64", columnNumber: "INT64", args: "STRING", httpClient: "STRING", httpMethod: "STRING", httpUrl: "STRING", receiverType: "STRING", receiverConstructor: "STRING", receiverIsLocal: "BOOLEAN", qualifier: "STRING" } },
  { label: "Field", properties: { name: "STRING", typeName: "STRING", isStatic: "BOOLEAN", isReadonly: "BOOLEAN", visibility: "STRING", line: "INT64" } },
  { label: "Variable", properties: { name: "STRING", kind: "STRING", isExported: "BOOLEAN", line: "INT64", stringValue: "STRING", stringTemplate: "STRING", httpClient: "STRING", visibility: "STRING", typeName: "STRING", constructorName: "STRING" } },
  { label: "Decorator", properties: { name: "STRING", expression: "STRING", line: "INT64", args: "STRING" } },
  { label: "Route", properties: { method: "STRING", path: "STRING", fullPath: "STRING", pathExpression: "STRING", receiverName: "STRING", line: "INT64", framework: "STRING", handlerName: "STRING", pendingHandlerRefs: "STRING", scopeFunctionId: "STRING", layers: "STRING", extractors: "STRING" } },
  { label: "EntryPoint", properties: { kind: "STRING", trigger: "STRING", receiverName: "STRING", library: "STRING", line: "INT64", handlerName: "STRING" } },
  { label: "EnvVar", properties: { name: "STRING", isPublic: "BOOLEAN" } },
  { label: "Page", properties: { path: "STRING", fullPath: "STRING", framework: "STRING", router: "STRING", kind: "STRING", slot: "STRING", line: "INT64", component: "STRING", componentSource: "STRING", loadChildren: "STRING", routes: "STRING", routerScope: "STRING" } },
  { label: "Component", properties: { name: "STRING", framework: "STRING", kind: "STRING", tagName: "STRING", selector: "STRING", templateUrl: "STRING", line: "INT64", endLine: "INT64", isExported: "BOOLEAN", props: "STRING", pendingRenders: "STRING", hooks: "STRING", lazySource: "STRING", lazyExport: "STRING", defaultExportWrapper: "STRING" } },
  { label: "Store", properties: { name: "STRING", library: "STRING", kind: "STRING", hook: "STRING", state: "STRING", getters: "STRING", actions: "STRING", line: "INT64", endLine: "INT64", reducer: "STRING", slices: "STRING" } },
  { label: "ConfigValue", properties: { name: "STRING", value: "STRING", valueType: "STRING", line: "INT64" } },
  { label: "DataModel", properties: { name: "STRING", library: "STRING", declaredIn: "STRING", line: "INT64" } },
  { label: "Style", properties: { name: "STRING", kind: "STRING", selector: "STRING", scope: "STRING", atRule: "STRING", line: "INT64", endLine: "INT64" } },
  { label: "Service", properties: { name: "STRING", package: "STRING", fullName: "STRING", line: "INT64" } },
  { label: "Rpc", properties: { name: "STRING", service: "STRING", package: "STRING", request: "STRING", response: "STRING", clientStreaming: "BOOLEAN", serverStreaming: "BOOLEAN", line: "INT64" } },
  { label: "Message", properties: { name: "STRING", package: "STRING", fullName: "STRING", line: "INT64" } },
  { label: "Table", properties: { name: "STRING", kind: "STRING", library: "STRING", schemaName: "STRING", provider: "STRING", declaredIn: "STRING", line: "INT64", columns: "STRING", migrations: "STRING", indexes: "STRING" } },
] as const satisfies readonly NodeTable[];

const coreRelationshipTables: readonly RelationshipTable[] = [
  { type: "CONTAINS_ROOT", from: "Repo", to: "Directory", properties: {  } },
  { type: "HAS_PACKAGE", from: "Repo", to: "Package", properties: {  } },
  { type: "CONTAINS_DIRECTORY", from: "Directory", to: "Directory", properties: {  } },
  { type: "CONTAINS_FILE", from: "Directory", to: "File", properties: {  } },
  { type: "PACKAGE_CONTAINS_FILE", from: "Package", to: "File", properties: {  } },
  { type: "PACKAGE_DECLARES_CONFIG", from: "Package", to: "ConfigValue", properties: {  } },
  { type: "PACKAGE_IMPORTS_PACKAGE", from: "Package", to: "Package", properties: { dependencyType: "STRING" } },
  { type: "IMPORTS_PACKAGE", from: "Import", to: "Package", properties: {  } },
  { type: "IMPORTS", from: "File", to: "Import", properties: {  } },
  { type: "RESOLVES_TO", from: "Import", to: "File", properties: {  } },
  { type: "DEFINES_FUNCTION", from: "File", to: "Function", properties: {  } },
  { type: "DEFINES_CLASS", from: "File", to: "Class", properties: {  } },
  { type: "DEFINES_INTERFACE", from: "File", to: "Interface", properties: {  } },
  { type: "DEFINES_TYPE_ALIAS", from: "File", to: "TypeAlias", properties: {  } },
  { type: "DEFINES_ENUM", from: "File", to: "Enum", properties: {  } },
  { type: "DEFINES_METHOD", from: "Class", to: "Function", properties: {  } },
  { type: "DEFINES_FIELD", from: "Class", to: "Field", properties: {  } },
  { type: "DEFINES_VARIABLE", from: "File", to: "Variable", properties: {  } },
  { type: "HAS_DECORATOR", from: "Class", to: "Decorator", properties: {  } },
  { type: "HAS_METHOD_DECORATOR", from: "Function", to: "Decorator", properties: {  } },
  { type: "ENUM_HAS_DECORATOR", from: "Enum", to: "Decorator", properties: {  } },
  { type: "INTERFACE_HAS_DECORATOR", from: "Interface", to: "Decorator", properties: {  } },
  { type: "EXTENDS", from: "Class", to: "Class", properties: {  } },
  { type: "DEFINED_BY", from: "Function", to: "Function", properties: {  } },
  { type: "IMPLEMENTS", from: "Class", to: "Interface", properties: {  } },
  { type: "RE_EXPORTS", from: "File", to: "Import", properties: {  } },
  { type: "RE_EXPORTS_FUNCTION", from: "File", to: "Function", properties: {  } },
  { type: "RE_EXPORTS_CLASS", from: "File", to: "Class", properties: {  } },
  { type: "RE_EXPORTS_VARIABLE", from: "File", to: "Variable", properties: {  } },
  { type: "CALLS", from: "Function", to: "Call", properties: {  } },
  { type: "CALL_RESOLVES_TO", from: "Call", to: "Function", properties: { via: "STRING", provenance: "STRING" } },
  { type: "MODULE_CALLS", from: "File", to: "Call", properties: {  } },
  { type: "PASSED_TO", from: "Function", to: "Call", properties: {  } },
  { type: "INITIALIZED_BY", from: "Variable", to: "Call", properties: {  } },
  { type: "DECLARES_ROUTE", from: "File", to: "Route", properties: {  } },
  { type: "ROUTE_HANDLED_BY", from: "Route", to: "Function", properties: {  } },
  { type: "DECLARES_ENTRYPOINT", from: "File", to: "EntryPoint", properties: {  } },
  { type: "ENTRYPOINT_HANDLED_BY", from: "EntryPoint", to: "Function", properties: {  } },
  { type: "DECLARES_COMPONENT", from: "File", to: "Component", properties: {  } },
  { type: "DECLARES_PAGE", from: "File", to: "Page", properties: {  } },
  { type: "PAGE_RENDERS", from: "Page", to: "Component", properties: {  } },
  { type: "PAGE_LOADS", from: "Page", to: "Function", properties: { server: "BOOLEAN" } },
  { type: "DECLARES_STORE", from: "File", to: "Store", properties: {  } },
  { type: "STORE_DEFINED_BY_FUNCTION", from: "Store", to: "Function", properties: {  } },
  { type: "STORE_ACTION", from: "Store", to: "Function", properties: {  } },
  { type: "READS_STORE", from: "Function", to: "Store", properties: { line: "INT64", members: "STRING" } },
  { type: "WRITES_STORE", from: "Function", to: "Store", properties: { line: "INT64", members: "STRING" } },
  { type: "REQUESTS", from: "Call", to: "Route", properties: { method: "STRING", url: "STRING", match: "STRING", provenance: "STRING" } },
  { type: "NAVIGATES_TO", from: "Call", to: "Page", properties: { url: "STRING", match: "STRING", provenance: "STRING" } },
  { type: "NAVIGATES_TO_FILE", from: "File", to: "Page", properties: { url: "STRING", match: "STRING", line: "INT64", provenance: "STRING" } },
  { type: "COMPONENT_DEFINED_BY", from: "Component", to: "Class", properties: {  } },
  { type: "COMPONENT_DEFINED_BY_FUNCTION", from: "Component", to: "Function", properties: {  } },
  { type: "RENDERS", from: "Component", to: "Component", properties: { props: "STRING", line: "INT64", client: "STRING", template: "STRING" } },
  { type: "USES_HOOK", from: "Function", to: "Function", properties: { line: "INT64" } },
  { type: "USES_CONTEXT", from: "Function", to: "Component", properties: { line: "INT64" } },
  { type: "ROUTE_LIFECYCLE_STEP", from: "Route", to: "Function", properties: { role: "STRING", scope: "STRING", hook: "STRING", orderIndex: "INT64", expression: "STRING" } },
  { type: "LIFECYCLE_PRECEDES", from: "Function", to: "Function", properties: { routeId: "STRING", scope: "STRING", orderIndex: "INT64" } },
  { type: "MOUNTS_VARIABLE", from: "Variable", to: "Variable", properties: { path: "STRING", pathExpression: "STRING", line: "INT64" } },
  { type: "MOUNTS_FUNCTION", from: "Variable", to: "Function", properties: { path: "STRING", pathExpression: "STRING", line: "INT64" } },
  { type: "MODULE_IMPORTS", from: "Class", to: "Class", properties: {  } },
  { type: "MODULE_PROVIDES", from: "Class", to: "Class", properties: {  } },
  { type: "MODULE_CONTROLS", from: "Class", to: "Class", properties: {  } },
  { type: "MODULE_EXPORTS", from: "Class", to: "Class", properties: {  } },
  { type: "MODULE_DECLARES", from: "Class", to: "Class", properties: {  } },
  { type: "INJECTS", from: "Class", to: "Class", properties: { fieldName: "STRING" } },
  { type: "USES_ENV_FILE", from: "File", to: "EnvVar", properties: { line: "INT64", access: "STRING" } },
  { type: "USES_ENV_FUNCTION", from: "Function", to: "EnvVar", properties: { line: "INT64", access: "STRING" } },
  { type: "USES_ENV_ROUTE", from: "Route", to: "EnvVar", properties: { line: "INT64", access: "STRING" } },
  { type: "DECLARES_ENV", from: "Repo", to: "EnvVar", properties: { file: "STRING", line: "INT64" } },
  { type: "USES_ENV_REPO", from: "Repo", to: "EnvVar", properties: { file: "STRING", line: "INT64", access: "STRING" } },
  { type: "USES_ENV_ENTRYPOINT", from: "EntryPoint", to: "EnvVar", properties: { line: "INT64", access: "STRING" } },
  { type: "RUNS_FILE", from: "EntryPoint", to: "File", properties: { line: "INT64", command: "STRING" } },
  { type: "RUNS_ENTRYPOINT", from: "EntryPoint", to: "EntryPoint", properties: { line: "INT64", command: "STRING" } },
  { type: "DECLARES_CONFIG_FILE", from: "File", to: "ConfigValue", properties: {  } },
  { type: "DECLARES_CONFIG_REPO", from: "Repo", to: "ConfigValue", properties: {  } },
  { type: "CONSUMES_CONFIG_FILE", from: "File", to: "ConfigValue", properties: { localName: "STRING" } },
  { type: "CONSUMES_CONFIG_FUNCTION", from: "Function", to: "ConfigValue", properties: { localName: "STRING" } },
  { type: "CONSUMES_CONFIG_ROUTE", from: "Route", to: "ConfigValue", properties: { localName: "STRING" } },
  { type: "ACCESSES_DATA_FILE", from: "File", to: "DataModel", properties: { operation: "STRING", library: "STRING", line: "INT64", expression: "STRING", file: "STRING", direct: "BOOLEAN" } },
  { type: "ACCESSES_DATA_FUNCTION", from: "Function", to: "DataModel", properties: { operation: "STRING", library: "STRING", line: "INT64", expression: "STRING", file: "STRING", direct: "BOOLEAN" } },
  { type: "ACCESSES_DATA_ROUTE", from: "Route", to: "DataModel", properties: { operation: "STRING", library: "STRING", line: "INT64", expression: "STRING", file: "STRING", direct: "BOOLEAN" } },
  { type: "ACCESSES_DATA_ENTRYPOINT", from: "EntryPoint", to: "DataModel", properties: { operation: "STRING", library: "STRING", line: "INT64", expression: "STRING", file: "STRING", direct: "BOOLEAN" } },
  { type: "DECLARES_STYLE", from: "File", to: "Style", properties: {  } },
  { type: "SELECTS_STYLE", from: "Style", to: "Style", properties: {  } },
  { type: "USES_STYLE_FILE", from: "File", to: "Style", properties: { line: "INT64", match: "STRING", expression: "STRING", provenance: "STRING" } },
  { type: "USES_STYLE_FUNCTION", from: "Function", to: "Style", properties: { line: "INT64", match: "STRING", expression: "STRING", provenance: "STRING" } },
  { type: "USES_STYLE_COMPONENT", from: "Component", to: "Style", properties: { line: "INT64", match: "STRING", expression: "STRING", provenance: "STRING" } },
  { type: "DECLARES_SERVICE", from: "File", to: "Service", properties: {  } },
  { type: "DECLARES_MESSAGE", from: "File", to: "Message", properties: {  } },
  { type: "HAS_RPC", from: "Service", to: "Rpc", properties: {  } },
  { type: "RPC_REQUEST", from: "Rpc", to: "Message", properties: {  } },
  { type: "RPC_RESPONSE", from: "Rpc", to: "Message", properties: {  } },
  { type: "RPC_SERVED_BY", from: "Rpc", to: "Interface", properties: { method: "STRING" } },
  { type: "RPC_IMPLEMENTED_BY", from: "Rpc", to: "Function", properties: {  } },
  { type: "SIGNAL_CONNECTS_TO", from: "Function", to: "Function", properties: { line: "INT64", file: "STRING", style: "STRING" } },
  { type: "MAPS_TO_TABLE", from: "DataModel", to: "Table", properties: {  } },
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

const coreNodeLabels = [
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
  "Store",
  "Style",
  "Service",
  "Rpc",
  "Message",
] as const;

// Every label with a table must be listed for graph_stats; the compiler checks it.
const coreNodeLabelsAreComplete: [Exclude<CoreNodeLabel, (typeof coreNodeLabels)[number]>] extends [never] ? true : never = true;
void coreNodeLabelsAreComplete;

export const baseGraphSchema: GraphSchema = {
  version: BASE_SCHEMA_VERSION,
  nodeTables: coreNodeTables,
  relationshipTables: coreRelationshipTables,
  nodeLabels: coreNodeLabels,
};

export function indexGraphSchema(schema: GraphSchema): GraphSchemaIndex {
  return {
    ...schema,
    relationshipTypes: schema.relationshipTables.map((table) => table.type),
    nodeTableByLabel: new Map(schema.nodeTables.map((table) => [table.label, table])),
    relationshipTableByType: new Map(schema.relationshipTables.map((table) => [table.type, table])),
  };
}

const PROPERTY_TYPES: readonly string[] = ["STRING", "INT64", "BOOLEAN"];

/** One table while merging: property order is kept in the array, so insertion at an anchor is cheap to express. */
type WorkingProperties = [name: string, type: PropertyType][];

type WorkingNodeTable = { label: string; properties: WorkingProperties };
type WorkingRelationshipTable = { type: string; from: string; to: string; properties: WorkingProperties };

/**
 * Merge `extensions` into `base`, in order. Pure; the inputs are not changed.
 *
 * - A node or relationship table that already exists may be declared again as
 *   long as the declarations are compatible (same endpoints for a
 *   relationship; no property with two types). Its new properties are added.
 * - Properties added to an existing table keep their group together, after
 *   `after` (a group after the same property goes behind earlier ones), or at
 *   the end. Re-declaring a property with the same type is a no-op.
 * - A property with a conflicting type, an unknown table, a node property
 *   named `id`, an unknown property type or a relationship with an unknown
 *   endpoint label is an error.
 * New node labels are appended to the `graph_stats` order.
 */
export function mergeGraphSchema(base: GraphSchema, extensions: readonly GraphSchemaExtension[]): GraphSchema {
  const nodeTables = new Map<string, WorkingNodeTable>(base.nodeTables.map((table) => [table.label, { label: table.label, properties: toWorking(table.properties) }]));
  const relationshipTables = new Map<string, WorkingRelationshipTable>(
    base.relationshipTables.map((table) => [table.type, { type: table.type, from: table.from, to: table.to, properties: toWorking(table.properties) }]),
  );
  const nodeLabels = [...base.nodeLabels];
  // Last property inserted after an anchor, per table: the next group with that anchor goes behind it.
  const chains = new Map<string, string>();

  for (const extension of extensions) {
    const fail = (message: string): never => {
      throw new Error(`Graph schema extension "${extension.id}": ${message}`);
    };

    for (const table of extension.nodeTables ?? []) {
      let existing = nodeTables.get(table.label);
      if (!existing) {
        nodeTables.set(table.label, existing = { label: table.label, properties: [] });
        if (!nodeLabels.includes(table.label)) nodeLabels.push(table.label);
      }
      for (const [name, type] of Object.entries(table.properties)) {
        addProperty(existing.properties, `node table ${table.label}`, name, type, fail, name === "id");
      }
    }

    for (const table of extension.relationshipTables ?? []) {
      let existing = relationshipTables.get(table.type);
      if (!existing) {
        relationshipTables.set(table.type, existing = { type: table.type, from: table.from, to: table.to, properties: [] });
      } else if (existing.from !== table.from || existing.to !== table.to) {
        fail(`relationship table ${table.type} is ${table.from} -> ${table.to} but already exists as ${existing.from} -> ${existing.to}`);
      }
      for (const [name, type] of Object.entries(table.properties)) {
        addProperty(existing.properties, `relationship table ${table.type}`, name, type, fail, false);
      }
    }

    const extend = (kind: "node" | "relationship", groups: readonly PropertyExtension[] | undefined) => {
      for (const group of groups ?? []) {
        const table = kind === "node" ? nodeTables.get(group.label) : relationshipTables.get(group.label);
        if (!table) return fail(`cannot add properties to unknown ${kind} table ${group.label}`);
        const owner = `${kind} table ${group.label}`;
        const added: string[] = [];
        for (const [name, type] of Object.entries(group.properties)) {
          const existing = table.properties.find(([existingName]) => existingName === name);
          if (existing || added.includes(name)) {
            addProperty(table.properties, owner, name, type, fail, false);
          } else {
            checkProperty(name, type, owner, fail, kind === "node" && name === "id");
            added.push(name);
          }
        }
        if (added.length === 0) continue;
        const chainKey = `${kind}\0${group.label}\0${group.after ?? ""}`;
        let position = table.properties.length;
        if (group.after !== undefined) {
          const anchor = table.properties.findIndex(([name]) => name === group.after);
          if (anchor !== -1) {
            const last = chains.get(chainKey);
            const lastIndex = last === undefined ? -1 : table.properties.findIndex(([name]) => name === last);
            position = Math.max(anchor, lastIndex) + 1;
          }
        }
        table.properties.splice(position, 0, ...added.map((name) => [name, group.properties[name]!] as [string, PropertyType]));
        if (group.after !== undefined) chains.set(chainKey, added[added.length - 1]!);
      }
    };
    extend("node", extension.nodeProperties);
    extend("relationship", extension.relationshipProperties);
  }

  for (const table of relationshipTables.values()) {
    for (const label of [table.from, table.to]) {
      if (!nodeTables.has(label)) throw new Error(`Graph schema: relationship table ${table.type} refers to unknown node table ${label}`);
    }
  }

  return {
    version: base.version,
    nodeTables: [...nodeTables.values()].map((table) => ({ label: table.label, properties: fromWorking(table.properties) })),
    relationshipTables: [...relationshipTables.values()].map((table) => ({ type: table.type, from: table.from, to: table.to, properties: fromWorking(table.properties) })),
    nodeLabels,
  };
}

function toWorking(properties: PropertyMap): WorkingProperties {
  return Object.entries(properties);
}

function fromWorking(properties: WorkingProperties): PropertyMap {
  return Object.fromEntries(properties);
}

function checkProperty(name: string, type: string, owner: string, fail: (message: string) => never, reserved: boolean): void {
  if (reserved) fail(`${owner} cannot declare a property named id (every node has one)`);
  if (!PROPERTY_TYPES.includes(type)) fail(`${owner} property ${name} has unknown type ${JSON.stringify(type)}`);
}

/** Add `name` at the end unless the table has it; a different type is a conflict. */
function addProperty(
  properties: WorkingProperties,
  owner: string,
  name: string,
  type: PropertyType,
  fail: (message: string) => never,
  reserved: boolean,
): void {
  checkProperty(name, type, owner, fail, reserved);
  const existing = properties.find(([existingName]) => existingName === name);
  if (!existing) properties.push([name, type]);
  else if (existing[1] !== type) fail(`${owner} property ${name} is ${type} but already declared as ${existing[1]}`);
}
