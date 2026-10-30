import type { SyntaxNode } from "../syntax/tree-sitter.js";

export function isFunctionNode(node: SyntaxNode): boolean {
  return [
    "function_declaration",
    "method_definition",
    "abstract_method_signature",
    "generator_function_declaration",
    "arrow_function",
    "function_expression",
  ].includes(node.type);
}

export function isClassNode(node: SyntaxNode): boolean {
  return node.type === "class_declaration" || node.type === "abstract_class_declaration";
}

export function isVariableFunctionValue(node: SyntaxNode | null | undefined): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression";
}

export function isVariableClassValue(node: SyntaxNode | null | undefined): boolean {
  return node?.type === "class" || node?.type === "class_expression";
}

export function isModuleLevelDeclarator(node: SyntaxNode): boolean {
  const declaration = node.parent;
  if (!declaration) return false;
  const grandparent = declaration.parent;
  return grandparent?.type === "program" || grandparent?.type === "export_statement";
}

export function extractStringSource(node: SyntaxNode): string | null {
  return node
    .namedChildren
    .find((child) => child.type === "string")?.text
    .replace(/^["']|["']$/g, "") ?? null;
}

export function extractName(node: SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

export function extractTypeScriptVisibility(node: SyntaxNode): string {
  const modifier = node.children.find((child) => child.type === "accessibility_modifier")?.text;
  return modifier === "private" || modifier === "protected" ? modifier : "public";
}

export function isTypeScriptAbstract(node: SyntaxNode): boolean {
  return node.type === "abstract_class_declaration"
    || node.type === "abstract_method_signature"
    || node.children.some((child) => child.type === "abstract");
}

export function serializeNameList(names: string[]): string | null {
  return names.length > 0 ? JSON.stringify(names) : null;
}

// A function stored under a property of a module-level object literal, and
// that property's name: `const api = { get: (id) => …, list() { … } }`,
// `export default { … }`, `module.exports = { … }`, nested objects too.
// Objects built inside functions, passed to calls or returned are not
// followed.
export function moduleObjectPropertyFunctionName(node: SyntaxNode): string | null {
  let key: SyntaxNode | null = null;
  let object: SyntaxNode | null = null;
  if (node.type === "method_definition" && node.parent?.type === "object") {
    key = node.childForFieldName("name");
    object = node.parent;
  } else if (
    (node.type === "arrow_function" || node.type === "function_expression")
    && !node.childForFieldName("name")
    && node.parent?.type === "pair"
    && node.parent.childForFieldName("value")?.id === node.id
  ) {
    key = node.parent.childForFieldName("key");
    object = node.parent.parent;
  }
  const name = key?.type === "property_identifier" ? key.text : key?.type === "string" ? key.text.slice(1, -1) : null;
  if (!name || object?.type !== "object") return null;

  let current: SyntaxNode = object;
  for (;;) {
    let parent = current.parent;
    while (parent && (parent.type === "as_expression" || parent.type === "satisfies_expression" || parent.type === "parenthesized_expression")) {
      current = parent;
      parent = parent.parent;
    }
    if (parent?.type === "pair" && parent.childForFieldName("value")?.id === current.id && parent.parent?.type === "object") {
      current = parent.parent;
      continue;
    }
    if (parent?.type === "variable_declarator") {
      return parent.childForFieldName("value")?.id === current.id && isModuleLevelDeclarator(parent) ? name : null;
    }
    if (parent?.type === "export_statement") return parent.children.some((child) => child.type === "default") ? name : null;
    if (parent?.type === "assignment_expression") {
      return parent.childForFieldName("right")?.id === current.id
        && /^(?:module\.)?exports(?:\.[\w$]+)?$/u.test(parent.childForFieldName("left")?.text ?? "")
        && parent.parent?.type === "expression_statement"
        && parent.parent.parent?.type === "program"
        ? name
        : null;
    }
    return null;
  }
}
