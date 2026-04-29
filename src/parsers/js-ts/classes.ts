import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../graph/model.js";
import {
  extractName,
  extractTypeScriptVisibility,
  isTypeScriptAbstract,
  serializeNameList,
} from "./common.js";
import { createCallNodes } from "./calls.js";
import { createFunctionNode } from "./functions.js";

export function createVariableClassNode(
  fileNodeId: string,
  declarator: Parser.SyntaxNode,
  valueNode: Parser.SyntaxNode,
): GraphNode | null {
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode || nameNode.type !== "identifier") {
    return null;
  }

  return createClassNode(fileNodeId, valueNode, {
    name: nameNode.text,
    line: declarator.startPosition.row + 1,
    isExported: declarator.parent?.parent?.type === "export_statement",
  });
}

export function createClassNode(
  fileNodeId: string,
  node: Parser.SyntaxNode,
  options: { name?: string; line?: number; isExported?: boolean } = {},
): GraphNode | null {
  const name = options.name ?? extractName(node);
  if (!name) {
    return null;
  }
  const line = options.line ?? node.startPosition.row + 1;

  return {
    id: `${fileNodeId}:class:${line}:${name}`,
    label: "Class",
    properties: {
      name,
      line,
      endLine: node.endPosition.row + 1,
      isExported: options.isExported ?? node.parent?.type === "export_statement",
      isAbstract: isTypeScriptAbstract(node),
      visibility: extractTypeScriptVisibility(node),
      extendsNames: serializeNameList(extractTypeScriptExtendsNames(node)),
      implementsNames: serializeNameList(extractTypeScriptImplementsNames(node)),
    },
  };
}

export function appendClassMembers(
  fileNodeId: string,
  classNode: GraphNode,
  classSyntaxNode: Parser.SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): void {
  for (const dec of classSyntaxNode.namedChildren.filter((c) => c.type === "decorator")) {
    const decoratorNode = createDecoratorNode(classNode.id, dec);
    nodes.push(decoratorNode);
    relationships.push({ from: classNode.id, to: decoratorNode.id, type: "HAS_DECORATOR", properties: {} });
  }

  const className = String(classNode.properties.name);
  const classBody = classSyntaxNode.childForFieldName("body");
  if (!classBody) {
    return;
  }

  let pendingDecorators: Parser.SyntaxNode[] = [];
  for (const child of classBody.namedChildren) {
    if (child.type === "decorator") {
      pendingDecorators.push(child);
      continue;
    }

    if (child.type === "public_field_definition" || child.type === "field_definition") {
      const fieldNode = createFieldNode(classNode.id, child);
      if (fieldNode) {
        nodes.push(fieldNode);
        relationships.push({
          from: classNode.id,
          to: fieldNode.id,
          type: "DEFINES_FIELD",
          properties: {},
        });
      }
      pendingDecorators = [];
      continue;
    }

    if (child.type !== "method_definition" && child.type !== "abstract_method_signature") {
      pendingDecorators = [];
      continue;
    }

    const methodNode = createFunctionNode(fileNodeId, child, className);
    if (methodNode) {
      const constructorFieldNodes = createConstructorParameterFieldNodes(classNode.id, child);
      nodes.push(...constructorFieldNodes);
      relationships.push(
        ...constructorFieldNodes.map((fieldNode) => ({
          from: classNode.id,
          to: fieldNode.id,
          type: "DEFINES_FIELD" as const,
          properties: {},
        })),
      );

      nodes.push(methodNode);
      relationships.push({
        from: classNode.id,
        to: methodNode.id,
        type: "DEFINES_METHOD",
        properties: {},
      });
      const callNodes = createCallNodes(methodNode.id, child);
      nodes.push(...callNodes);
      relationships.push(
        ...callNodes.map((callNode) => ({
          from: methodNode.id,
          to: callNode.id,
          type: "CALLS" as const,
          properties: {},
        })),
      );
      for (const dec of pendingDecorators) {
        const decoratorNode = createDecoratorNode(methodNode.id, dec);
        nodes.push(decoratorNode);
        relationships.push({ from: methodNode.id, to: decoratorNode.id, type: "HAS_METHOD_DECORATOR", properties: {} });
      }
    }

    pendingDecorators = [];
  }
}

function createConstructorParameterFieldNodes(
  classNodeId: string,
  methodNode: Parser.SyntaxNode,
): GraphNode[] {
  if (extractName(methodNode) !== "constructor") {
    return [];
  }

  const paramsNode = methodNode.childForFieldName("parameters");
  if (!paramsNode) {
    return [];
  }

  return paramsNode.namedChildren
    .map((param) => createConstructorParameterFieldNode(classNodeId, param))
    .filter((node): node is GraphNode => node !== null);
}

function createConstructorParameterFieldNode(
  classNodeId: string,
  paramNode: Parser.SyntaxNode,
): GraphNode | null {
  const hasAccessibilityModifier = paramNode.children.some((child) => child.type === "accessibility_modifier");
  const isReadonly = paramNode.children.some((child) => child.type === "readonly");
  if (!hasAccessibilityModifier && !isReadonly) {
    return null;
  }

  const nameNode = paramNode.childForFieldName("pattern")
    ?? paramNode.namedChildren.find((child) => child.type === "identifier" || child.type === "property_identifier");
  if (!nameNode) {
    return null;
  }

  const typeAnnotation = paramNode.childForFieldName("type");
  const typeName = typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : null;
  const modifier = paramNode.children.find((child) => child.type === "accessibility_modifier")?.text;
  const visibility = modifier === "private" || modifier === "protected" ? modifier : "public";

  return {
    id: `${classNodeId}:field:${paramNode.startPosition.row + 1}:${nameNode.text}`,
    label: "Field",
    properties: {
      name: nameNode.text,
      typeName,
      isStatic: false,
      isReadonly,
      visibility,
      line: paramNode.startPosition.row + 1,
    },
  };
}

function createFieldNode(classNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const nameNode = node.childForFieldName("name")
    ?? node.namedChildren.find((child) => child.type === "property_identifier" || child.type === "private_property_identifier");
  if (!nameNode) return null;

  const name = nameNode.text;
  const typeAnnotation = node.childForFieldName("type");
  const typeName = typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : null;
  const isStatic = node.children.some((c) => c.type === "static");
  const isReadonly = node.children.some((c) => c.type === "readonly");

  let visibility: string;
  if (name.startsWith("#")) {
    visibility = "private";
  } else {
    const modifier = node.children.find((c) => c.type === "accessibility_modifier")?.text;
    visibility = modifier === "private" || modifier === "protected" ? modifier : "public";
  }

  return {
    id: `${classNodeId}:field:${node.startPosition.row + 1}:${name}`,
    label: "Field",
    properties: {
      name,
      typeName,
      isStatic,
      isReadonly,
      visibility,
      line: node.startPosition.row + 1,
    },
  };
}

function createDecoratorNode(targetId: string, node: Parser.SyntaxNode): GraphNode {
  const inner = node.namedChildren[0];
  let name: string;
  if (!inner) {
    name = node.text.replace(/^@/, "").trim();
  } else if (inner.type === "identifier") {
    name = inner.text;
  } else if (inner.type === "call_expression") {
    name = inner.childForFieldName("function")?.text ?? inner.text;
  } else {
    name = inner.text;
  }
  return {
    id: `${targetId}:decorator:${node.startPosition.row + 1}:${name}`,
    label: "Decorator",
    properties: {
      name,
      expression: node.text,
      line: node.startPosition.row + 1,
    },
  };
}

function extractTypeScriptExtendsNames(node: Parser.SyntaxNode): string[] {
  const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
  const extendsClause = heritage?.namedChildren.find((child) => child.type === "extends_clause");
  if (extendsClause) {
    return extractTypeNames(extendsClause);
  }
  return heritage ? extractTypeNames(heritage) : [];
}

function extractTypeScriptImplementsNames(node: Parser.SyntaxNode): string[] {
  const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
  const implementsClause = heritage?.namedChildren.find((child) => child.type === "implements_clause");
  return implementsClause ? extractTypeNames(implementsClause) : [];
}

function extractTypeNames(node: Parser.SyntaxNode): string[] {
  return node.namedChildren
    .filter((child) => (
      child.type === "identifier"
      || child.type === "type_identifier"
      || child.type === "nested_type_identifier"
      || child.type === "generic_type"
    ))
    .map((child) => child.text);
}
