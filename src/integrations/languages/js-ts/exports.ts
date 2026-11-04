import type { SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { extractStringSource } from "./common.js";

export type CjsExportBinding = {
  exportedName: string;
  localName: string | null;
  line: number;
};

export function createDefaultExportExpressionNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  if (node.type !== "export_statement" || !node.children.some((child) => child.type === "default")) {
    return null;
  }

  const exported = defaultExported(node);
  if (!exported || isNamedDefaultDeclaration(exported)) {
    return null;
  }

  return {
    id: `${fileNodeId}:variable:${node.startPosition.row + 1}:default`,
    label: "Variable",
    properties: {
      name: "default",
      kind: "export_default",
      isExported: true,
      line: node.startPosition.row + 1,
    },
  };
}

// The local name an ES module's default export refers to: the declaration in
// `export default function name()` / `export default class Name`, the
// identifier in `export default name`, or `name` in `export { name as default }`.
// What `export default` exports: the first named child that is no decorator
// (`@Component(…) export default class X {}` puts the decorator first) or
// comment.
function defaultExported(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type !== "decorator" && child.type !== "comment") ?? null;
}

export function extractDefaultExportName(node: SyntaxNode): string | null {
  if (node.type !== "export_statement" || extractStringSource(node)) {
    return null;
  }

  if (node.children.some((child) => child.type === "default")) {
    const exported = defaultExported(node);
    if (!exported) return null;
    if (exported.type === "identifier") return exported.text;
    return isNamedDefaultDeclaration(exported) ? exported.childForFieldName("name")?.text ?? null : null;
  }

  const exportClause = node.namedChildren.find((child) => child.type === "export_clause");
  const specifier = exportClause?.namedChildren.find((child) => (
    child.type === "export_specifier" && child.childForFieldName("alias")?.text === "default"
  ));
  return specifier?.childForFieldName("name")?.text ?? null;
}

// The CommonJS counterpart of a default export, for a top-level
// `module.exports = …` (also chained, `exports = module.exports = …`):
// `name` for `= name` or `= function name() {}`, or `from` for a module
// re-exported whole, `= require("./x")`.
export function extractCjsDefaultExport(node: SyntaxNode): { name: string } | { from: string } | null {
  let statement = node.parent;
  while (statement?.type === "assignment_expression") statement = statement.parent;
  if (statement?.type !== "expression_statement" || statement.parent?.type !== "program") return null;

  const left = node.childForFieldName("left");
  let right = node.childForFieldName("right");
  if (!left || !right || !isModuleExportsMember(left)) return null;
  while (right?.type === "assignment_expression") right = right.childForFieldName("right");
  if (!right) return null;
  if (right.type === "identifier") return { name: right.text };
  if (right.type === "function_expression" || right.type === "class") {
    const name = right.childForFieldName("name")?.text;
    return name ? { name } : null;
  }
  const source = right.type === "call_expression" && right.childForFieldName("function")?.text === "require"
    ? right.childForFieldName("arguments")?.namedChildren[0]
    : null;
  return source?.type === "string" ? { from: source.text.slice(1, -1) } : null;
}

export function extractLocalReExportNames(node: SyntaxNode): string[] {
  if (extractStringSource(node)) {
    return [];
  }

  const exportClause = node.namedChildren.find((child) => child.type === "export_clause");
  if (!exportClause) {
    return [];
  }

  return exportClause.namedChildren
    .filter((child) => child.type === "export_specifier")
    .map((specifier) => specifier.childForFieldName("name")?.text)
    .filter((name): name is string => name !== undefined);
}

export function createLocalReExportRelationships(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  exportNames: string[],
): GraphRelationship[] {
  if (exportNames.length === 0) {
    return [];
  }

  const localDefinitionsByName = indexLocalDefinitions(fileNodeId, nodes, relationships);

  return Array.from(new Set(exportNames)).flatMap((name) => {
    const target = localDefinitionsByName.get(name);
    if (!target) {
      return [];
    }

    return [{
      from: fileNodeId,
      to: target.id,
      type: "RE_EXPORTS" as const,
      properties: {},
    }];
  });
}

export function extractCjsExportBindings(node: SyntaxNode): CjsExportBinding[] {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || !right) {
    return [];
  }

  if (isModuleExportsMember(left)) {
    if (right.type !== "object") {
      return [];
    }

    return right.namedChildren.flatMap((child) => extractCjsObjectExportBinding(child));
  }

  const propertyName = extractModuleExportsPropertyName(left);
  if (!propertyName) {
    return [];
  }

  return [{
    exportedName: propertyName,
    localName: null,
    line: node.startPosition.row + 1,
  }];
}

export function extractCjsObjectAssignExportBindings(node: SyntaxNode): CjsExportBinding[] {
  if (node.type !== "call_expression") return [];

  const fn = node.childForFieldName("function");
  if (fn?.text !== "Object.assign") return [];

  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  const target = args[0];
  const sourceObjects = args.slice(1).filter((arg) => arg.type === "object");
  if (!target || sourceObjects.length === 0 || !isCjsExportTarget(target)) {
    return [];
  }

  return sourceObjects.flatMap((objectNode) => (
    objectNode.namedChildren.flatMap((child) => extractCjsObjectExportBinding(child))
  ));
}

export function applyCjsExportBindings(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  bindings: CjsExportBinding[],
): void {
  if (bindings.length === 0) {
    return;
  }

  const localDefinitionsByName = indexLocalDefinitions(fileNodeId, nodes, relationships);
  const uniqueBindings = new Map<string, CjsExportBinding>();
  for (const binding of bindings) {
    uniqueBindings.set(binding.exportedName, binding);
  }

  for (const binding of uniqueBindings.values()) {
    const existingNode = localDefinitionsByName.get(binding.localName ?? binding.exportedName)
      ?? localDefinitionsByName.get(binding.exportedName);
    if (existingNode) {
      existingNode.properties.isExported = true;
      continue;
    }

    if (nodes.some((node) => node.label === "Variable" && node.id === createCjsExportVariableId(fileNodeId, binding))) {
      continue;
    }

    const variableNode = createCjsExportVariableNode(fileNodeId, binding);
    nodes.push(variableNode);
    relationships.push({
      from: fileNodeId,
      to: variableNode.id,
      type: "DEFINES_VARIABLE",
      properties: {},
    });
  }
}

function indexLocalDefinitions(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): Map<string, GraphNode> {
  const localDefinitionIds = new Set(
    relationships
      .filter((relationship) => (
        relationship.from === fileNodeId
        && (
          relationship.type === "DEFINES_FUNCTION"
          || relationship.type === "DEFINES_CLASS"
          || relationship.type === "DEFINES_VARIABLE"
        )
      ))
      .map((relationship) => relationship.to),
  );

  const definitions = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (!localDefinitionIds.has(node.id)) {
      continue;
    }

    const name = node.properties.name;
    if (typeof name === "string" && !definitions.has(name)) {
      definitions.set(name, node);
    }
  }

  return definitions;
}

function extractCjsObjectExportBinding(node: SyntaxNode): CjsExportBinding[] {
  if (node.type === "shorthand_property_identifier") {
    return [{
      exportedName: node.text,
      localName: node.text,
      line: node.startPosition.row + 1,
    }];
  }

  if (node.type !== "pair") {
    return [];
  }

  const key = node.childForFieldName("key");
  if (!key) {
    return [];
  }

  const exportedName = normalizeObjectPropertyName(key);
  if (!exportedName) {
    return [];
  }

  return [{
    exportedName,
    localName: null,
    line: node.startPosition.row + 1,
  }];
}

function createCjsExportVariableNode(fileNodeId: string, binding: CjsExportBinding): GraphNode {
  return {
    id: createCjsExportVariableId(fileNodeId, binding),
    label: "Variable",
    properties: {
      name: binding.exportedName,
      kind: "module.exports",
      isExported: true,
      line: binding.line,
    },
  };
}

function createCjsExportVariableId(fileNodeId: string, binding: CjsExportBinding): string {
  return `${fileNodeId}:variable:${binding.line}:${binding.exportedName}`;
}

function isNamedDefaultDeclaration(node: SyntaxNode): boolean {
  return node.type === "function_declaration"
    || node.type === "generator_function_declaration"
    || node.type === "class_declaration"
    || node.type === "abstract_class_declaration";
}

// The name of an anonymous function assigned to a module-level CommonJS
// export, `exports.compileETag = function (val) { … }` (or `module.exports.x
// = () => …`): the function is named by the property, so it gets a Function
// node and importers' calls resolve to it.
export function cjsExportFunctionName(node: SyntaxNode): string | null {
  if ((node.type !== "function_expression" && node.type !== "arrow_function") || node.childForFieldName("name")) return null;
  const assignment = node.parent;
  if (assignment?.type !== "assignment_expression" || assignment.childForFieldName("right")?.id !== node.id) return null;
  if (assignment.parent?.type !== "expression_statement" || assignment.parent.parent?.type !== "program") return null;
  const left = assignment.childForFieldName("left");
  return left ? extractModuleExportsPropertyName(left) : null;
}

function extractModuleExportsPropertyName(node: SyntaxNode): string | null {
  if (node.type !== "member_expression") {
    return null;
  }

  const object = node.childForFieldName("object");
  if (!object || !isCjsExportTarget(object)) {
    return null;
  }

  const property = node.childForFieldName("property");
  return property?.type === "property_identifier" ? property.text : null;
}

function isModuleExportsMember(node: SyntaxNode): boolean {
  if (node.type !== "member_expression") {
    return false;
  }

  const object = node.childForFieldName("object");
  const property = node.childForFieldName("property");
  return object?.type === "identifier" && object.text === "module"
    && property?.type === "property_identifier" && property.text === "exports";
}

function isExportsIdentifier(node: SyntaxNode): boolean {
  return node.type === "identifier" && node.text === "exports";
}

function isCjsExportTarget(node: SyntaxNode): boolean {
  return isModuleExportsMember(node) || isExportsIdentifier(node);
}

function normalizeObjectPropertyName(node: SyntaxNode): string | null {
  if (
    node.type === "property_identifier"
    || node.type === "identifier"
    || node.type === "shorthand_property_identifier"
  ) {
    return node.text;
  }

  if (node.type === "string") {
    return node.text.replace(/^["']|["']$/g, "");
  }

  return null;
}
