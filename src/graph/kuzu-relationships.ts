import type { GraphNode, GraphRelationship } from "./model.js";

export function physicalRelationshipType(
  relationship: GraphRelationship,
  nodeLabelById: Map<string, GraphNode["label"]>,
): string {
  if (relationship.type !== "RE_EXPORTS") {
    return relationship.type;
  }

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
