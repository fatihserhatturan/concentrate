export type GraphNodeLabel =
  | "Repo"
  | "Directory"
  | "File"
  | "Import"
  | "Function"
  | "Class"
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
  | "EXTENDS"
  | "IMPLEMENTS"
  | "CALLS"
  | "CALL_RESOLVES_TO";

export type GraphProperties = Record<string, string | number | boolean | null>;

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
