import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTreeSkippingErrors, type SyntaxNode } from "../syntax/tree-sitter.js";
import { createPythonImportNodes, readDunderAll } from "./imports.js";
import { classBases, classFields, classKind, decoratorsOf, pythonParameters, type PythonDecorator } from "./declarations.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { SupportedLanguage } from "../../../core/scan/language.js";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import {
  analyzeMemberCallExpression,
  walk,
  walkScoped,
} from "../tree-sitter-utils.js";

// Node types whose children are statements: one with a syntax error is left
// out on its own, and the rest of the file is kept. A broken `def` header makes
// the grammar wrap the statements around it in one ERROR node, whose children
// are statements as well.
const statementParents = new Set(["module", "block", "ERROR"]);

export const pythonParser: LanguageParser = {
  language: "python",
  parse: (rootPath, filePath) => parsePythonFile(rootPath, filePath, "python"),
};

async function parsePythonFile(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const nodes: GraphNode[] = [
    {
      id: fileNodeId,
      label: "File",
      properties: {
        path: filePath,
        relativePath,
        language,
      },
    },
  ];
  const relationships: GraphRelationship[] = [];

  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors("python", source, statementParents);
  try {
    const importIds = new Set<string>();
    const allNames = readDunderAll(tree.rootNode);
    if (allNames) nodes[0]!.properties.allNames = JSON.stringify(allNames);

    walk(tree.rootNode, (node) => {
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        for (const importNode of createPythonImportNodes(fileNodeId, node, importIds)) {
          nodes.push(importNode);
          relationships.push({ from: fileNodeId, to: importNode.id, type: "IMPORTS", properties: {} });
        }
      }

      if (node.type === "class_definition") {
        addClass(fileNodeId, node, nodes, relationships);
      } else if (node.type === "function_definition") {
        addFunction(fileNodeId, node, nodes, relationships);
      }
    });

    for (const statement of tree.rootNode.namedChildren) {
      const variable = createVariableNode(fileNodeId, statement, allNames);
      if (variable) {
        nodes.push(variable);
        relationships.push({ from: fileNodeId, to: variable.id, type: "DEFINES_VARIABLE", properties: {} });
      }
    }

    const parsed: ParsedSourceFile = { fileNodeId, nodes, relationships };
    if (skippedLines.length > 0) {
      parsed.warnings = [`Syntax error: left out the statement${skippedLines.length === 1 ? "" : "s"} at line${skippedLines.length === 1 ? "" : "s"} ${skippedLines.join(", ")}`];
    }
    return parsed;
  } finally {
    tree.delete();
  }
}

// The class a `def` is written directly in (through `@decorators`), or null.
function enclosingClass(node: SyntaxNode): SyntaxNode | null {
  const holder = node.parent?.type === "decorated_definition" ? node.parent : node;
  const block = holder.parent;
  return block?.type === "block" && block.parent?.type === "class_definition" ? block.parent : null;
}

function addDecorators(nodes: GraphNode[], relationships: GraphRelationship[], ownerId: string, relation: string, definition: SyntaxNode): PythonDecorator[] {
  const decorators = decoratorsOf(definition);
  for (const decorator of decorators) {
    const id = `${ownerId}:decorator:${decorator.line}:${decorator.name}`;
    if (nodes.some((candidate) => candidate.id === id)) continue;
    nodes.push({
      id,
      label: "Decorator",
      properties: { name: decorator.name, expression: decorator.expression, line: decorator.line, args: JSON.stringify(decorator.args) },
    });
    relationships.push({ from: ownerId, to: id, type: relation as GraphRelationship["type"], properties: {} });
  }
  return decorators;
}

function addClass(fileNodeId: string, node: SyntaxNode, nodes: GraphNode[], relationships: GraphRelationship[]): void {
  const name = extractName(node);
  if (!name) return;
  const bases = classBases(node);
  const decorators = decoratorsOf(node);
  const kind = classKind(bases, decorators);
  const line = node.startPosition.row + 1;
  const body = node.childForFieldName("body");
  const typeParameters = node.childForFieldName("type_parameters")?.text;
  const baseNames = bases.names.filter((base) => !["object", "Generic", "Protocol", "ABC"].includes(base.split(".").at(-1)!));
  const common = {
    name,
    line,
    endLine: node.endPosition.row + 1,
    isExported: !name.startsWith("_"),
    visibility: pythonVisibility(name),
    ...(typeParameters ? { typeParameters } : {}),
  };

  // A Protocol or ABC is an interface: its methods are what subclasses implement.
  if (kind === "protocol" || kind === "abc") {
    const methods = methodDefinitions(body);
    const signatures: Record<string, { parameters: Array<string | null>; returnType: string | null }> = {};
    for (const method of methods) {
      signatures[method.name] = {
        parameters: pythonParameters(method.node.childForFieldName("parameters")).filter((parameter) => parameter.name !== "self" && parameter.name !== "cls").map((parameter) => parameter.type),
        returnType: method.node.childForFieldName("return_type")?.text ?? null,
      };
    }
    const interfaceNode: GraphNode = {
      id: `${fileNodeId}:interface:${line}:${name}`,
      label: "Interface",
      properties: {
        ...common,
        kind,
        methods: JSON.stringify(methods.map((method) => method.name)),
        methodSignatures: JSON.stringify(signatures),
        embeds: JSON.stringify(baseNames),
      },
    };
    nodes.push(interfaceNode);
    relationships.push({ from: fileNodeId, to: interfaceNode.id, type: "DEFINES_INTERFACE", properties: {} });
    addDecorators(nodes, relationships, interfaceNode.id, "INTERFACE_HAS_DECORATOR", node);
    return;
  }

  const fields = classFields(body, kind);
  const hasAbstractMethod = methodDefinitions(body).some((method) => isAbstractMethod(method.node));
  const classNode: GraphNode = {
    id: `${fileNodeId}:class:${line}:${name}`,
    label: "Class",
    properties: {
      ...common,
      isAbstract: hasAbstractMethod,
      extendsNames: serializeNameList(baseNames),
      implementsNames: null,
      ...(kind ? { kind } : {}),
      ...(fields.length > 0 ? { fields: JSON.stringify(fields) } : {}),
    },
  };
  nodes.push(classNode);
  relationships.push({ from: fileNodeId, to: classNode.id, type: "DEFINES_CLASS", properties: {} });
  addDecorators(nodes, relationships, classNode.id, "HAS_DECORATOR", node);
}

function methodDefinitions(body: SyntaxNode | null): Array<{ name: string; node: SyntaxNode }> {
  const methods: Array<{ name: string; node: SyntaxNode }> = [];
  for (const child of body?.namedChildren ?? []) {
    const definition = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    if (definition?.type !== "function_definition") continue;
    const name = extractName(definition);
    if (name) methods.push({ name, node: definition });
  }
  return methods;
}

function isAbstractMethod(node: SyntaxNode): boolean {
  return decoratorsOf(node).some((decorator) => /(?:^|\.)abstract(?:method|property|classmethod|staticmethod)$/u.test(decorator.name));
}

function addFunction(fileNodeId: string, node: SyntaxNode, nodes: GraphNode[], relationships: GraphRelationship[]): void {
  const owner = enclosingClass(node);
  const ownerName = owner ? extractName(owner) : null;
  const functionNode = createFunctionNode(fileNodeId, node, ownerName ?? undefined);
  if (!functionNode) return;
  const decorators = addDecorators(nodes, relationships, functionNode.id, "HAS_METHOD_DECORATOR", node);
  if (owner) {
    const decoratorNames = decorators.map((decorator) => decorator.name.split(".").at(-1)!);
    functionNode.properties.methodKind = decoratorNames.includes("staticmethod") ? "staticmethod"
      : decoratorNames.includes("classmethod") ? "classmethod"
        : decoratorNames.includes("property") || decoratorNames.includes("cached_property") ? "property"
          : "method";
  }
  functionNode.properties.isAbstract = isAbstractMethod(node);
  nodes.push(functionNode);

  const ownerBases = owner ? classBases(owner) : null;
  const ownerKind = owner && ownerBases ? classKind(ownerBases, decoratorsOf(owner)) : null;
  if (owner && ownerKind !== "protocol" && ownerKind !== "abc") {
    const ownerId = `${fileNodeId}:class:${owner.startPosition.row + 1}:${ownerName}`;
    relationships.push({ from: ownerId, to: functionNode.id, type: "DEFINES_METHOD", properties: {} });
  } else {
    // A method of an interface is a function of the file (like a trait's default methods).
    if (owner) functionNode.properties.methodKind = "interface-method";
    relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
  }

  const callNodes = createCallNodes(functionNode.id, node);
  nodes.push(...callNodes);
  relationships.push(...callNodes.map((callNode) => ({ from: functionNode.id, to: callNode.id, type: "CALLS" as const, properties: {} })));
}

// `NAME = value` and `NAME: Type = value` at module level.
function createVariableNode(fileNodeId: string, statement: SyntaxNode, allNames: string[] | null): GraphNode | null {
  if (statement.type !== "expression_statement") return null;
  const assignment = statement.namedChildren[0];
  if (!assignment || assignment.type !== "assignment") return null;
  const left = assignment.childForFieldName("left");
  if (!left || left.type !== "identifier" || left.text === "__all__") return null;
  const name = left.text;
  const line = assignment.startPosition.row + 1;
  const type = assignment.childForFieldName("type")?.text ?? null;
  const value = assignment.childForFieldName("right");
  const literal = value?.type === "string" && value.namedChildren.every((part) => part.type === "string_start" || part.type === "string_content" || part.type === "string_end") && !/^[a-zA-Z]*[fF]/u.test(value.text) && !value.text.includes("\\")
    ? value.namedChildren.filter((part) => part.type === "string_content").map((part) => part.text).join("")
    : null;
  return {
    id: `${fileNodeId}:variable:${line}:${name}`,
    label: "Variable",
    properties: {
      name,
      kind: /^[A-Z][A-Z0-9_]*$/u.test(name) ? "const" : "variable",
      isExported: allNames ? allNames.includes(name) : !name.startsWith("_"),
      visibility: pythonVisibility(name),
      line,
      ...(type ? { typeName: type } : {}),
      ...(literal === null ? {} : { stringValue: literal }),
    },
  };
}

function createFunctionNode(fileNodeId: string, node: SyntaxNode, className?: string): GraphNode | null {
  const name = extractName(node);
  if (!name) {
    return null;
  }
  const typeParameters = node.childForFieldName("type_parameters")?.text;

  return {
    id: `${fileNodeId}:function:${node.startPosition.row + 1}:${name}`,
    label: "Function",
    properties: {
      name,
      kind: node.type,
      methodKind: null,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      className: className ?? null,
      isExported: !name.startsWith("_"),
      isAsync: node.children.some((c) => c.type === "async"),
      isAbstract: false,
      visibility: pythonVisibility(name),
      parameters: JSON.stringify(pythonParameters(node.childForFieldName("parameters"))),
      returnType: node.childForFieldName("return_type")?.text ?? null,
      ...(typeParameters ? { typeParameters } : {}),
    },
  };
}

function pythonVisibility(name: string): string {
  if (name.startsWith("__")) {
    return "dunder";
  }
  return name.startsWith("_") ? "private" : "public";
}

function serializeNameList(names: string[]): string | null {
  return names.length > 0 ? JSON.stringify(names) : null;
}

function createCallNodes(functionNodeId: string, node: SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type !== "call") {
      return;
    }

    const callExpression = analyzeMemberCallExpression(child.childForFieldName("function")?.text);
    if (!callExpression) {
      return;
    }

    calls.push({
      id: `${functionNodeId}:call:${child.startPosition.row + 1}:${child.startPosition.column}:${callExpression.expression}`,
      label: "Call",
      properties: {
        name: callExpression.expression,
        expression: callExpression.expression,
        callee: callExpression.callee,
        receiver: callExpression.receiver,
        line: child.startPosition.row + 1,
        columnNumber: child.startPosition.column,
      },
    });
  }, (child) => child.type === "function_definition" || child.type === "class_definition");

  return calls;
}

function extractName(node: SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}
