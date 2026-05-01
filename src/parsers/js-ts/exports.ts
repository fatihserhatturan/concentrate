import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../graph/model.js";
import { extractStringSource } from "./common.js";

export type CjsExportBinding = {
  exportedName: string;
  localName: string | null;
  line: number;
};

export function createDefaultExportExpressionNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  if (node.type !== "export_statement" || !node.children.some((child) => child.type === "default")) {
    return null;
  }

  const exported = node.namedChildren[0];
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

export function extractLocalReExportNames(node: Parser.SyntaxNode): string[] {
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

export function extractCjsExportBindings(node: Parser.SyntaxNode): CjsExportBinding[] {
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

export function extractCjsObjectAssignExportBindings(node: Parser.SyntaxNode): CjsExportBinding[] {
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

function extractCjsObjectExportBinding(node: Parser.SyntaxNode): CjsExportBinding[] {
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

function isNamedDefaultDeclaration(node: Parser.SyntaxNode): boolean {
  return node.type === "function_declaration"
    || node.type === "generator_function_declaration"
    || node.type === "class_declaration"
    || node.type === "abstract_class_declaration";
}

function extractModuleExportsPropertyName(node: Parser.SyntaxNode): string | null {
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

function isModuleExportsMember(node: Parser.SyntaxNode): boolean {
  if (node.type !== "member_expression") {
    return false;
  }

  const object = node.childForFieldName("object");
  const property = node.childForFieldName("property");
  return object?.type === "identifier" && object.text === "module"
    && property?.type === "property_identifier" && property.text === "exports";
}

function isExportsIdentifier(node: Parser.SyntaxNode): boolean {
  return node.type === "identifier" && node.text === "exports";
}

function isCjsExportTarget(node: Parser.SyntaxNode): boolean {
  return isModuleExportsMember(node) || isExportsIdentifier(node);
}

function normalizeObjectPropertyName(node: Parser.SyntaxNode): string | null {
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
