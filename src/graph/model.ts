export type GraphNodeLabel =
  | "Repo"
  | "Directory"
  | "File"
  | "Import"
  | "Function"
  | "Class"
  | "Field"
  | "Variable"
  | "Decorator"
  | "Interface"
  | "TypeAlias"
  | "Enum"
  | "Call";

export type GraphRelationshipType =
  | "CONTAINS_ROOT"
  | "CONTAINS_DIRECTORY"
  | "CONTAINS_FILE"
  | "IMPORTS"
  | "RESOLVES_TO"
  | "DEFINES_FUNCTION"
  | "DEFINES_CLASS"
  | "DEFINES_INTERFACE"
  | "DEFINES_TYPE_ALIAS"
  | "DEFINES_ENUM"
  | "DEFINES_METHOD"
  | "DEFINES_FIELD"
  | "DEFINES_VARIABLE"
  | "HAS_DECORATOR"
  | "HAS_METHOD_DECORATOR"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "RE_EXPORTS"
  | "CALLS"
  | "CALL_RESOLVES_TO";

export type GraphProperties = Record<string, string | number | boolean | null>;

export type ImportBinding = {
  imported: string;
  local: string;
  kind: "named" | "default" | "namespace";
};

export type GraphNode = {
  id: string;
  label: GraphNodeLabel;
  properties: GraphProperties;
};

export type GraphRelationship = {
  from: string;
  to: string;
  type: GraphRelationshipType;
  properties: GraphProperties;
};

export type ParsedSourceFile = {
  fileNodeId: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
};
