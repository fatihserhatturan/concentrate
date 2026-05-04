import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { extractName } from "./common.js";

export function createTypeScriptDeclarationNode(
  fileNodeId: string,
  node: Parser.SyntaxNode,
): { node: GraphNode; relationshipType: GraphRelationship["type"] } | null {
  const declaration = typeScriptDeclarationMetadata(node.type);
  if (!declaration) {
    return null;
  }

  const name = extractName(node);
  if (!name) {
    return null;
  }

  return {
    node: {
      id: `${fileNodeId}:${declaration.idSegment}:${node.startPosition.row + 1}:${name}`,
      label: declaration.label,
      properties: {
        name,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isExported: node.parent?.type === "export_statement",
      },
    },
    relationshipType: declaration.relationshipType,
  };
}

function typeScriptDeclarationMetadata(nodeType: string): {
  idSegment: string;
  label: GraphNode["label"];
  relationshipType: GraphRelationship["type"];
} | null {
  switch (nodeType) {
    case "interface_declaration":
      return {
        idSegment: "interface",
        label: "Interface",
        relationshipType: "DEFINES_INTERFACE",
      };
    case "type_alias_declaration":
      return {
        idSegment: "type-alias",
        label: "TypeAlias",
        relationshipType: "DEFINES_TYPE_ALIAS",
      };
    case "enum_declaration":
      return {
        idSegment: "enum",
        label: "Enum",
        relationshipType: "DEFINES_ENUM",
      };
    default:
      return null;
  }
}
