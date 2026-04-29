import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import type { GraphNode, GraphRelationship, ParsedSourceFile, ImportBinding } from "../graph/model.js";
import type { SupportedLanguage } from "../scanner/language.js";
import type { LanguageParser } from "./types.js";
import {
  analyzeMemberCallExpression,
  createTreeSitterInput,
  walk,
  walkScoped,
} from "./tree-sitter-utils.js";

const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

export const javascriptParser: LanguageParser = {
  language: "javascript",
  parse: (rootPath, filePath) => parseJavaScriptLikeFile(rootPath, filePath, "javascript"),
};

export const typescriptParser: LanguageParser = {
  language: "typescript",
  parse: (rootPath, filePath) => parseJavaScriptLikeFile(rootPath, filePath, "typescript"),
};

async function parseJavaScriptLikeFile(
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
  const localReExportNames: string[] = [];
  const cjsExportBindings: CjsExportBinding[] = [];

  const tree = (language === "typescript" ? tsParser : jsParser).parse(createTreeSitterInput(source));
  if (tree.rootNode.hasError) {
    throw new Error("Syntax error");
  }

  walk(tree.rootNode, (node) => {
    if (node.type === "import_statement") {
      const importNode = createImportNode(fileNodeId, node);
      if (importNode) {
        nodes.push(importNode);
        relationships.push({
          from: fileNodeId,
          to: importNode.id,
          type: "IMPORTS",
          properties: {},
        });
      }
    }

    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "import") {
        const args = node.childForFieldName("arguments");
        const sourceNode = args?.namedChildren.find((c) => c.type === "string");
        if (sourceNode) {
          const source = sourceNode.text.replace(/^["']|["']$/g, "");
          const dynamicImportNode = createDynamicImportNode(fileNodeId, node, source);
          if (!nodes.some((n) => n.id === dynamicImportNode.id)) {
            nodes.push(dynamicImportNode);
            relationships.push({
              from: fileNodeId,
              to: dynamicImportNode.id,
              type: "IMPORTS",
              properties: {},
            });
          }
        }
      }

      if (fn?.type === "identifier" && fn.text === "require") {
        const args = node.childForFieldName("arguments");
        const sourceNode = args?.namedChildren.find((c) => c.type === "string");
        if (sourceNode) {
          const source = sourceNode.text.replace(/^["']|["']$/g, "");
          const cjsImportNode = createCjsImportNode(fileNodeId, node, source);
          if (!nodes.some((n) => n.id === cjsImportNode.id)) {
            nodes.push(cjsImportNode);
            relationships.push({
              from: fileNodeId,
              to: cjsImportNode.id,
              type: "IMPORTS",
              properties: {},
            });
          }
        }
      }
    }

    if (node.type === "export_statement") {
      localReExportNames.push(...extractLocalReExportNames(node));

      const reExportNode = createReExportImportNode(fileNodeId, node);
      if (reExportNode) {
        nodes.push(reExportNode);
        relationships.push({
          from: fileNodeId,
          to: reExportNode.id,
          type: "IMPORTS",
          properties: {},
        });

        if (reExportNode.properties.isWildcard === true) {
          relationships.push({
            from: fileNodeId,
            to: reExportNode.id,
            type: "RE_EXPORTS",
            properties: {},
          });
        }
      }
    }

    if (node.type === "assignment_expression") {
      cjsExportBindings.push(...extractCjsExportBindings(node));
    }

    if (isFunctionNode(node) && node.type !== "method_definition" && node.type !== "abstract_method_signature") {
      const functionNode = createFunctionNode(fileNodeId, node);
      if (functionNode) {
        nodes.push(functionNode);
        relationships.push({
          from: fileNodeId,
          to: functionNode.id,
          type: "DEFINES_FUNCTION",
          properties: {},
        });

        const callNodes = createCallNodes(functionNode.id, node);
        nodes.push(...callNodes);
        relationships.push(
          ...callNodes.map((callNode) => ({
            from: functionNode.id,
            to: callNode.id,
            type: "CALLS" as const,
            properties: {},
          })),
        );
      }
    }

    if (node.type === "variable_declarator") {
      const valueChild = node.childForFieldName("value");
      if (isVariableClassValue(valueChild)) {
        const classNode = createVariableClassNode(fileNodeId, node, valueChild!);
        if (classNode) {
          nodes.push(classNode);
          relationships.push({
            from: fileNodeId,
            to: classNode.id,
            type: "DEFINES_CLASS",
            properties: {},
          });
          appendClassMembers(fileNodeId, classNode, valueChild!, nodes, relationships);
        }
      } else if (isVariableFunctionValue(valueChild)) {
        const functionNode = createVariableFunctionNode(fileNodeId, node, valueChild!);
        if (functionNode) {
          nodes.push(functionNode);
          relationships.push({
            from: fileNodeId,
            to: functionNode.id,
            type: "DEFINES_FUNCTION",
            properties: {},
          });

          const callNodes = createCallNodes(functionNode.id, valueChild!);
          nodes.push(...callNodes);
          relationships.push(
            ...callNodes.map((callNode) => ({
              from: functionNode.id,
              to: callNode.id,
              type: "CALLS" as const,
              properties: {},
            })),
          );
        }
      } else if (isModuleLevelDeclarator(node)) {
        const variableNode = createVariableNode(fileNodeId, node);
        if (variableNode) {
          nodes.push(variableNode);
          relationships.push({
            from: fileNodeId,
            to: variableNode.id,
            type: "DEFINES_VARIABLE",
            properties: {},
          });
        }
      }
    }

    if (isClassNode(node)) {
      const classNode = createClassNode(fileNodeId, node);
      if (classNode) {
        nodes.push(classNode);
        relationships.push({
          from: fileNodeId,
          to: classNode.id,
          type: "DEFINES_CLASS",
          properties: {},
        });

        appendClassMembers(fileNodeId, classNode, node, nodes, relationships);
      }
    }

    if (language === "typescript") {
      const typeDeclarationNode = createTypeScriptDeclarationNode(fileNodeId, node);
      if (typeDeclarationNode) {
        nodes.push(typeDeclarationNode.node);
        relationships.push({
          from: fileNodeId,
          to: typeDeclarationNode.node.id,
          type: typeDeclarationNode.relationshipType,
          properties: {},
        });
      }
    }
  });

  applyCjsExportBindings(fileNodeId, nodes, relationships, cjsExportBindings);
  relationships.push(...createLocalReExportRelationships(fileNodeId, nodes, relationships, localReExportNames));

  return { fileNodeId, nodes, relationships };
}

function isFunctionNode(node: Parser.SyntaxNode): boolean {
  return [
    "function_declaration",
    "method_definition",
    "abstract_method_signature",
    "generator_function_declaration",
    "arrow_function",
    "function_expression",
  ].includes(node.type);
}

function isClassNode(node: Parser.SyntaxNode): boolean {
  return node.type === "class_declaration" || node.type === "abstract_class_declaration";
}

function isVariableFunctionValue(node: Parser.SyntaxNode | null | undefined): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression";
}

function isVariableClassValue(node: Parser.SyntaxNode | null | undefined): boolean {
  return node?.type === "class" || node?.type === "class_expression";
}

function isModuleLevelDeclarator(node: Parser.SyntaxNode): boolean {
  const declaration = node.parent;
  if (!declaration) return false;
  const grandparent = declaration.parent;
  return grandparent?.type === "program" || grandparent?.type === "export_statement";
}

function createVariableNode(fileNodeId: string, declarator: Parser.SyntaxNode): GraphNode | null {
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
    },
  };
}

type CjsExportBinding = {
  exportedName: string;
  localName: string | null;
  line: number;
};

function createVariableFunctionNode(
  fileNodeId: string,
  declarator: Parser.SyntaxNode,
  valueNode: Parser.SyntaxNode,
): GraphNode | null {
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode || nameNode.type !== "identifier") {
    return null;
  }

  return {
    id: `${fileNodeId}:function:${declarator.startPosition.row + 1}:${nameNode.text}`,
    label: "Function",
    properties: {
      name: nameNode.text,
      kind: valueNode.type,
      methodKind: null,
      line: declarator.startPosition.row + 1,
      endLine: valueNode.endPosition.row + 1,
      className: null,
      isExported: declarator.parent?.parent?.type === "export_statement",
      isAsync: valueNode.children.some((c) => c.type === "async"),
      isAbstract: false,
      visibility: "public",
      parameters: extractFunctionParameters(valueNode),
      returnType: extractReturnType(valueNode),
    },
  };
}

function createVariableClassNode(
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

function createImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const source = extractStringSource(node);

  if (!source) {
    return null;
  }

  return {
    id: `${fileNodeId}:import:${node.startPosition.row + 1}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: node.text,
      line: node.startPosition.row + 1,
      isReExport: false,
      isWildcard: false,
      isDynamic: false,
      isCjs: false,
      bindings: serializeImportBindings(node),
    },
  };
}

function createDynamicImportNode(fileNodeId: string, node: Parser.SyntaxNode, source: string): GraphNode {
  return {
    id: `${fileNodeId}:import:${node.startPosition.row + 1}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: node.text,
      line: node.startPosition.row + 1,
      isReExport: false,
      isWildcard: false,
      isDynamic: true,
      isCjs: false,
      bindings: null,
    },
  };
}

function createCjsImportNode(fileNodeId: string, node: Parser.SyntaxNode, source: string): GraphNode {
  return {
    id: `${fileNodeId}:import:${node.startPosition.row + 1}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: node.text,
      line: node.startPosition.row + 1,
      isReExport: false,
      isWildcard: false,
      isDynamic: false,
      isCjs: true,
      bindings: extractCjsBindings(node),
    },
  };
}

function extractCjsBindings(requireCall: Parser.SyntaxNode): string | null {
  const declarator = requireCall.parent;
  if (!declarator || declarator.type !== "variable_declarator") {
    return null;
  }

  const nameNode = declarator.childForFieldName("name");
  if (!nameNode) {
    return null;
  }

  if (nameNode.type === "object_pattern") {
    const bindings: ImportBinding[] = [];
    for (const child of nameNode.namedChildren) {
      if (child.type === "shorthand_property_identifier_pattern") {
        bindings.push({ imported: child.text, local: child.text, kind: "named" });
      } else if (child.type === "pair_pattern") {
        const key = child.childForFieldName("key");
        const value = child.childForFieldName("value");
        if (key && value) {
          bindings.push({ imported: key.text, local: value.text, kind: "named" });
        }
      }
    }
    return bindings.length > 0 ? JSON.stringify(bindings) : null;
  }

  if (nameNode.type === "identifier") {
    return JSON.stringify([{ imported: "default", local: nameNode.text, kind: "default" }]);
  }

  return null;
}

function extractCjsExportBindings(node: Parser.SyntaxNode): CjsExportBinding[] {
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

function applyCjsExportBindings(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  bindings: CjsExportBinding[],
): void {
  if (bindings.length === 0) {
    return;
  }

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
  const localDefinitionsByName = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (!localDefinitionIds.has(node.id)) {
      continue;
    }

    const name = node.properties.name;
    if (typeof name === "string" && !localDefinitionsByName.has(name)) {
      localDefinitionsByName.set(name, node);
    }
  }

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

function extractModuleExportsPropertyName(node: Parser.SyntaxNode): string | null {
  if (node.type !== "member_expression") {
    return null;
  }

  const object = node.childForFieldName("object");
  if (!object || !isModuleExportsMember(object)) {
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

function serializeImportBindings(node: Parser.SyntaxNode): string | null {
  const bindings: ImportBinding[] = [];
  const importClause = node.namedChildren.find((c) => c.type === "import_clause");
  if (!importClause) {
    return null;
  }

  for (const child of importClause.namedChildren) {
    if (child.type === "identifier") {
      bindings.push({ imported: "default", local: child.text, kind: "default" });
    } else if (child.type === "namespace_import") {
      const nameNode = child.childForFieldName("alias") ?? child.namedChildren.find((c) => c.type === "identifier");
      if (nameNode) {
        bindings.push({ imported: "*", local: nameNode.text, kind: "namespace" });
      }
    } else if (child.type === "named_imports") {
      for (const specifier of child.namedChildren) {
        if (specifier.type !== "import_specifier") continue;
        const nameNode = specifier.childForFieldName("name");
        const aliasNode = specifier.childForFieldName("alias");
        if (nameNode) {
          bindings.push({
            imported: nameNode.text,
            local: aliasNode?.text ?? nameNode.text,
            kind: "named",
          });
        }
      }
    }
  }

  return bindings.length > 0 ? JSON.stringify(bindings) : null;
}

function createReExportImportNode(fileNodeId: string, node: Parser.SyntaxNode): GraphNode | null {
  const source = extractStringSource(node);
  if (!source) {
    return null;
  }

  return {
    id: `${fileNodeId}:import:${node.startPosition.row + 1}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: node.text,
      line: node.startPosition.row + 1,
      isReExport: true,
      isWildcard: isWildcardReExport(node),
      isDynamic: false,
      isCjs: false,
      bindings: null,
    },
  };
}

function extractLocalReExportNames(node: Parser.SyntaxNode): string[] {
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

function createLocalReExportRelationships(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  exportNames: string[],
): GraphRelationship[] {
  if (exportNames.length === 0) {
    return [];
  }

  const localDefinitionsByName = new Map<string, GraphNode>();
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

  for (const node of nodes) {
    if (!localDefinitionIds.has(node.id)) {
      continue;
    }

    const name = node.properties.name;
    if (typeof name === "string" && !localDefinitionsByName.has(name)) {
      localDefinitionsByName.set(name, node);
    }
  }

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

function extractStringSource(node: Parser.SyntaxNode): string | null {
  return node
    .namedChildren
    .find((child) => child.type === "string")?.text
    .replace(/^["']|["']$/g, "") ?? null;
}

function isWildcardReExport(node: Parser.SyntaxNode): boolean {
  return /^export\s+\*/.test(node.text);
}

function createFunctionNode(fileNodeId: string, node: Parser.SyntaxNode, className?: string): GraphNode | null {
  const name = extractName(node);
  if (!name) {
    return null;
  }

  return {
    id: `${fileNodeId}:function:${node.startPosition.row + 1}:${name}`,
    label: "Function",
    properties: {
      name,
      kind: node.type,
      methodKind: extractMethodKind(node),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      className: className ?? null,
      isExported: node.parent?.type === "export_statement",
      isAsync: node.children.some((c) => c.type === "async"),
      isAbstract: isTypeScriptAbstract(node),
      visibility: extractTypeScriptVisibility(node),
      parameters: extractFunctionParameters(node),
      returnType: extractReturnType(node),
    },
  };
}

function extractMethodKind(node: Parser.SyntaxNode): string | null {
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

function extractFunctionParameters(functionNode: Parser.SyntaxNode): string {
  const paramsNode = functionNode.childForFieldName("parameters");
  if (!paramsNode) {
    return "[]";
  }

  // Single identifier: arrow shorthand `x => ...`
  if (paramsNode.type === "identifier") {
    return JSON.stringify([{ name: paramsNode.text, type: null }]);
  }

  const params: { name: string; type: string | null }[] = [];
  for (const child of paramsNode.namedChildren) {
    const param = extractSingleParameter(child);
    if (param) {
      params.push(param);
    }
  }
  return JSON.stringify(params);
}

function extractSingleParameter(node: Parser.SyntaxNode): { name: string; type: string | null } | null {
  if (node.type === "identifier") {
    return { name: node.text, type: null };
  }
  if (node.type === "required_parameter" || node.type === "optional_parameter") {
    const pattern = node.childForFieldName("pattern");
    const typeAnnotation = node.childForFieldName("type");
    if (!pattern) return null;
    return {
      name: pattern.text,
      type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : null,
    };
  }
  if (node.type === "rest_parameter") {
    const pattern = node.childForFieldName("pattern");
    const typeAnnotation = node.childForFieldName("type");
    if (!pattern) return null;
    return {
      name: `...${pattern.text}`,
      type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : null,
    };
  }
  if (node.type === "assignment_pattern") {
    const left = node.childForFieldName("left");
    return left ? { name: left.text, type: null } : null;
  }
  return null;
}

function extractReturnType(functionNode: Parser.SyntaxNode): string | null {
  const returnTypeNode = functionNode.childForFieldName("return_type");
  if (!returnTypeNode) return null;
  return returnTypeNode.text.replace(/^:\s*/, "");
}

function createClassNode(
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

function appendClassMembers(
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

function extractTypeScriptVisibility(node: Parser.SyntaxNode): string {
  const modifier = node.children.find((child) => child.type === "accessibility_modifier")?.text;
  return modifier === "private" || modifier === "protected" ? modifier : "public";
}

function isTypeScriptAbstract(node: Parser.SyntaxNode): boolean {
  return node.type === "abstract_class_declaration"
    || node.type === "abstract_method_signature"
    || node.children.some((child) => child.type === "abstract");
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

function serializeNameList(names: string[]): string | null {
  return names.length > 0 ? JSON.stringify(names) : null;
}

function createTypeScriptDeclarationNode(
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

function createCallNodes(functionNodeId: string, node: Parser.SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type !== "call_expression") {
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
  }, (child) => isFunctionNode(child) || isClassNode(child) || isVariableClassValue(child));

  return calls;
}

function extractName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}
