import type { SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";

export function createVariableNode(fileNodeId: string, declarator: SyntaxNode): GraphNode | null {
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
      ...stringTemplateProperty(declarator.childForFieldName("value")),
    },
  };
}

// A value built from other values, for the http-requests contributor to
// resolve: the body of a template literal with substitutions
// (`${API_ORIGIN}/api`), or an env read, alone or with a literal fallback
// (`process.env.API_URL ?? "http://localhost:4000"`), as one substitution.
function stringTemplateProperty(valueNode: SyntaxNode | null): { stringTemplate?: string } {
  if (valueNode?.type === "template_string" && valueNode.namedChildren.some((child) => child?.type === "template_substitution")) {
    return { stringTemplate: valueNode.text.slice(1, -1) };
  }
  return valueNode && isEnvRead(valueNode) ? { stringTemplate: `\${${valueNode.text}}` } : {};
}

function isEnvRead(node: SyntaxNode): boolean {
  if (node.type === "binary_expression") {
    const operator = node.childForFieldName("operator")?.type;
    const right = node.childForFieldName("right");
    const left = node.childForFieldName("left");
    return (operator === "??" || operator === "||") && right?.type === "string" && left !== null && isEnvRead(left);
  }
  return node.type === "member_expression" && /^(?:process|import\.meta)\.env\.[A-Za-z_]\w*$/u.test(node.text);
}

function extractStringValue(valueNode: SyntaxNode | null): string | null {
  // A template literal counts when it has no substitutions.
  if (valueNode?.type === "template_string" && !valueNode.namedChildren.some((child) => child?.type === "template_substitution")) {
    return valueNode.text.slice(1, -1);
  }
  return valueNode?.type === "string" ? valueNode.text.replace(/^["'`]|["'`]$/g, "") : null;
}
