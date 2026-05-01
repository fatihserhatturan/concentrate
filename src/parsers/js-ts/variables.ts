import type Parser from "tree-sitter";
import type { GraphNode } from "../../graph/model.js";

export function createVariableNode(fileNodeId: string, declarator: Parser.SyntaxNode): GraphNode | null {
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode || nameNode.type !== "identifier") return null;

  const declaration = declarator.parent!;
  const kind = declaration.type === "variable_declaration"
    ? "var"
    : declaration.children[0]?.type === "const" ? "const" : "let";
  const isExported = declaration.parent?.type === "export_statement";

  return {
    id: `${fileNodeId}:variable:${declarator.startPosition.row + 1}:${nameNode.text}`,
    label: "Variable",
    properties: {
      name: nameNode.text,
      kind,
      isExported,
      line: declarator.startPosition.row + 1,
      stringValue: extractStringValue(declarator.childForFieldName("value")),
    },
  };
}

function extractStringValue(valueNode: Parser.SyntaxNode | null): string | null {
  return valueNode?.type === "string" ? valueNode.text.replace(/^["'`]|["'`]$/g, "") : null;
}
