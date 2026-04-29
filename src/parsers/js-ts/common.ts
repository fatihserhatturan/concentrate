import type Parser from "tree-sitter";

export function isFunctionNode(node: Parser.SyntaxNode): boolean {
  return [
    "function_declaration",
    "method_definition",
    "abstract_method_signature",
    "generator_function_declaration",
    "arrow_function",
    "function_expression",
  ].includes(node.type);
}

export function isClassNode(node: Parser.SyntaxNode): boolean {
  return node.type === "class_declaration" || node.type === "abstract_class_declaration";
}

export function isVariableFunctionValue(node: Parser.SyntaxNode | null | undefined): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression";
}

export function isVariableClassValue(node: Parser.SyntaxNode | null | undefined): boolean {
  return node?.type === "class" || node?.type === "class_expression";
}

export function isModuleLevelDeclarator(node: Parser.SyntaxNode): boolean {
  const declaration = node.parent;
  if (!declaration) return false;
  const grandparent = declaration.parent;
  return grandparent?.type === "program" || grandparent?.type === "export_statement";
}

export function extractStringSource(node: Parser.SyntaxNode): string | null {
  return node
    .namedChildren
    .find((child) => child.type === "string")?.text
    .replace(/^["']|["']$/g, "") ?? null;
}

export function extractName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

export function extractTypeScriptVisibility(node: Parser.SyntaxNode): string {
  const modifier = node.children.find((child) => child.type === "accessibility_modifier")?.text;
  return modifier === "private" || modifier === "protected" ? modifier : "public";
}

export function isTypeScriptAbstract(node: Parser.SyntaxNode): boolean {
  return node.type === "abstract_class_declaration"
    || node.type === "abstract_method_signature"
    || node.children.some((child) => child.type === "abstract");
}

export function serializeNameList(names: string[]): string | null {
  return names.length > 0 ? JSON.stringify(names) : null;
}
