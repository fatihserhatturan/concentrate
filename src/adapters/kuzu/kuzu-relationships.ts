import type { GraphNode, GraphRelationship } from "../../core/graph/model.js";

export function physicalRelationshipType(
  relationship: GraphRelationship,
  nodeLabelById: Map<string, GraphNode["label"]>,
): string {
  if (relationship.type === "RE_EXPORTS") {
    return reExportRelationshipType(relationship, nodeLabelById);
  }

  if (relationship.type === "MOUNTS") {
    return mountsRelationshipType(relationship, nodeLabelById);
  }

  if (relationship.type === "USES_ENV") {
    return sourceLabelRelationshipType("USES_ENV", relationship, nodeLabelById);
  }

  if (relationship.type === "CONSUMES_CONFIG") {
    return sourceLabelRelationshipType("CONSUMES_CONFIG", relationship, nodeLabelById);
  }

  if (relationship.type === "DECLARES_CONFIG") {
    return sourceLabelRelationshipType("DECLARES_CONFIG", relationship, nodeLabelById);
  }

  if (relationship.type === "ACCESSES_DATA") {
    return sourceLabelRelationshipType("ACCESSES_DATA", relationship, nodeLabelById);
  }

  return relationship.type;
}

function sourceLabelRelationshipType(
  baseType: string,
  relationship: GraphRelationship,
  nodeLabelById: Map<string, GraphNode["label"]>,
): string {
  const sourceLabel = nodeLabelById.get(relationship.from);
  switch (sourceLabel) {
    case "Repo":
      return `${baseType}_REPO`;
    case "Route":
      return `${baseType}_ROUTE`;
    case "EntryPoint":
      return `${baseType}_ENTRYPOINT`;
    case "Function":
      return `${baseType}_FUNCTION`;
    default:
      return `${baseType}_FILE`;
  }
}

function reExportRelationshipType(
  relationship: GraphRelationship,
  nodeLabelById: Map<string, GraphNode["label"]>,
): string {
  const targetLabel = nodeLabelById.get(relationship.to);
  switch (targetLabel) {
    case "Function":
      return "RE_EXPORTS_FUNCTION";
    case "Class":
      return "RE_EXPORTS_CLASS";
    case "Variable":
      return "RE_EXPORTS_VARIABLE";
    default:
      return "RE_EXPORTS";
  }
}

function mountsRelationshipType(
  relationship: GraphRelationship,
  nodeLabelById: Map<string, GraphNode["label"]>,
): string {
  const targetLabel = nodeLabelById.get(relationship.to);
  switch (targetLabel) {
    case "Function":
      return "MOUNTS_FUNCTION";
    case "Variable":
      return "MOUNTS_VARIABLE";
    default:
      return "MOUNTS_VARIABLE";
  }
}
