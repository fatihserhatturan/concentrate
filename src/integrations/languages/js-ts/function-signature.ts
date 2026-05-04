import type Parser from "tree-sitter";

export function extractMethodKind(node: Parser.SyntaxNode): string | null {
  if (node.type !== "method_definition" && node.type !== "abstract_method_signature") {
    return null;
  }

  if (node.children.some((child) => child.type === "get")) {
    return "get";
  }

  if (node.children.some((child) => child.type === "set")) {
    return "set";
  }

  return "method";
}

export function extractFunctionParameters(functionNode: Parser.SyntaxNode): string {
  const paramsNode = functionNode.childForFieldName("parameters");
  if (!paramsNode) {
    return "[]";
  }

  if (paramsNode.type === "identifier") {
    return JSON.stringify([{ name: paramsNode.text, type: null }]);
  }

  const params = paramsNode.namedChildren
    .map(extractSingleParameter)
    .filter((param): param is { name: string; type: string | null } => param !== null);
  return JSON.stringify(params);
}

export function extractReturnType(functionNode: Parser.SyntaxNode): string | null {
  const returnTypeNode = functionNode.childForFieldName("return_type");
  return returnTypeNode ? returnTypeNode.text.replace(/^:\s*/, "") : null;
}

function extractSingleParameter(node: Parser.SyntaxNode): { name: string; type: string | null } | null {
  if (node.type === "identifier") {
    return { name: node.text, type: null };
  }

  if (node.type === "assignment_pattern") {
    const left = node.childForFieldName("left");
    return left ? { name: left.text, type: null } : null;
  }

  return extractTypedParameter(node);
}

function extractTypedParameter(node: Parser.SyntaxNode): { name: string; type: string | null } | null {
  if (node.type !== "required_parameter" && node.type !== "optional_parameter" && node.type !== "rest_parameter") {
    return null;
  }

  const pattern = node.childForFieldName("pattern");
  const typeAnnotation = node.childForFieldName("type");
  if (!pattern) return null;

  return {
    name: node.type === "rest_parameter" ? `...${pattern.text}` : pattern.text,
    type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : null,
  };
}
