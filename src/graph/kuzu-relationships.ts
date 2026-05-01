import type { GraphNode, GraphRelationship } from "./model.js";

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

  return relationship.type;
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
