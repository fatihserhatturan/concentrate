export type GraphNodeLabel =
  | "Repo"
  | "File"
  | "Import"
  | "Function"
  | "Class"
  | "Call";

export type GraphRelationshipType =
  | "CONTAINS"
  | "IMPORTS"
  | "DEFINES_FUNCTION"
  | "DEFINES_CLASS"
  | "CALLS";

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
