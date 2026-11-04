import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTreeSkippingErrors, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import {
  analyzeMemberCallExpression,
  walk,
  walkScoped,
} from "../tree-sitter-utils.js";

// Node types whose children are statements, declarations or members: one with
// a syntax error is left out on its own, and the rest of the file is kept.
const statementParents = new Set([
  "source_file",
  "statement_list",
  "block",
  "field_declaration_list",
  "interface_type",
  "import_spec_list",
  "var_declaration",
  "const_declaration",
  "type_declaration",
]);

export const goParser: LanguageParser = {
  language: "go",
  parse: (rootPath, filePath) => parseGoFile(rootPath, filePath),
};

async function parseGoFile(rootPath: string, filePath: string): Promise<ParsedSourceFile> {
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
        language: "go",
      },
    },
  ];
  const relationships: GraphRelationship[] = [];

  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors("go", source, statementParents);
  try {

    // A package is a directory's files with the same package clause.
    const packageName = tree.rootNode.namedChildren
      .find((child) => child.type === "package_clause")
      ?.namedChildren.find((child) => child.type === "package_identifier")?.text;
    if (packageName) nodes[0]!.properties.packageName = packageName;

    walk(tree.rootNode, (node) => {
      if (node.type === "import_spec") {
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

      if (node.type === "type_spec" && node.childForFieldName("type")?.type === "interface_type") {
        const interfaceNode = createInterfaceNode(fileNodeId, node);
        nodes.push(interfaceNode);
        relationships.push({ from: fileNodeId, to: interfaceNode.id, type: "DEFINES_INTERFACE", properties: {} });
      } else if (node.type === "type_alias" || (node.type === "type_spec" && node.childForFieldName("type")?.type !== "struct_type")) {
        const aliasNode = createTypeAliasNode(fileNodeId, node);
        if (aliasNode) {
          nodes.push(aliasNode);
          relationships.push({ from: fileNodeId, to: aliasNode.id, type: "DEFINES_TYPE_ALIAS", properties: {} });
        }
      }

      if (node.type === "type_spec" && node.childForFieldName("type")?.type === "struct_type") {
        const classNode = createStructNode(fileNodeId, node);
        if (classNode) {
          nodes.push(classNode);
          relationships.push({
            from: fileNodeId,
            to: classNode.id,
            type: "DEFINES_CLASS",
            properties: {},
          });
        }
      }
    });

    // Second pass: process functions and methods now that all structs are indexed.
    const classesByName = new Map(
      nodes
        .filter((n) => n.label === "Class")
        .map((n) => [String(n.properties.name), n.id]),
    );

    walk(tree.rootNode, (node) => {
      if (node.type !== "function_declaration" && node.type !== "method_declaration") return;

      const receiverTypeName = node.type === "method_declaration"
        ? extractGoReceiverTypeName(node)
        : null;
      const classNodeId = receiverTypeName ? classesByName.get(receiverTypeName) : undefined;
      const className = receiverTypeName ?? undefined;

      const functionNode = createFunctionNode(fileNodeId, node, className);
      if (!functionNode) return;

      nodes.push(functionNode);

      if (classNodeId) {
        relationships.push({ from: classNodeId, to: functionNode.id, type: "DEFINES_METHOD", properties: {} });
      } else {
        relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
      }

      const callNodes = createCallNodes(functionNode.id, node, localTypes(node));
      nodes.push(...callNodes);
      relationships.push(
        ...callNodes.map((callNode) => ({
          from: functionNode.id,
          to: callNode.id,
          type: "CALLS" as const,
          properties: {},
        })),
      );
    });

    const parsed: ParsedSourceFile = { fileNodeId, nodes, relationships };
    if (skippedLines.length > 0) {
      parsed.warnings = [`Syntax error: left out the statement${skippedLines.length === 1 ? "" : "s"} at line${skippedLines.length === 1 ? "" : "s"} ${skippedLines.join(", ")}`];
    }
    return parsed;
  } finally {
    tree.delete();
  }
}

function createImportNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  const source = node
    .namedChildren
    .find((child) => child.type === "interpreted_string_literal" || child.type === "raw_string_literal")
    ?.text
    .replace(/^["`]|["`]$/g, "");

  if (!source) {
    return null;
  }

  // `name "path"`: an alias, `_` (imported for its side effects) or `.`
  // (its names used unqualified).
  const alias = node.childForFieldName("name")?.text ?? null;
  return {
    id: `${fileNodeId}:import:${node.startPosition.row + 1}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: node.text,
      line: node.startPosition.row + 1,
      ...(alias === null ? {} : { alias }),
    },
  };
}

function createFunctionNode(fileNodeId: string, node: SyntaxNode, className?: string): GraphNode | null {
  const name = extractFunctionName(node);
  if (!name) {
    return null;
  }

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
      isExported: /^[A-Z]/.test(name),
      isAsync: false,
      isAbstract: false,
      visibility: goVisibility(name),
      parameters: JSON.stringify(goParameters(node.childForFieldName("parameters"))),
      ...typeParameters(node),
      returnType: node.childForFieldName("result")?.text ?? null,
    },
  };
}

// `(a, b string, c *db.Store)` as [{name, type}]; unnamed parameters get a
// null name.
function goParameters(list: SyntaxNode | null): Array<{ name: string | null; type: string | null }> {
  const parameters: Array<{ name: string | null; type: string | null }> = [];
  for (const declaration of list?.namedChildren ?? []) {
    if (declaration.type !== "parameter_declaration" && declaration.type !== "variadic_parameter_declaration") continue;
    const typeNode = declaration.childForFieldName("type");
    const type = typeNode ? `${declaration.type === "variadic_parameter_declaration" ? "..." : ""}${typeNode.text}` : null;
    const names = declaration.childrenForFieldName("name");
    if (names.length === 0) parameters.push({ name: null, type });
    for (const name of names) parameters.push({ name: name.text, type });
  }
  return parameters;
}

function extractGoReceiverTypeName(node: SyntaxNode): string | null {
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return null;

  for (const param of receiver.namedChildren) {
    if (param.type !== "parameter_declaration") continue;
    for (const typeChild of param.namedChildren) {
      if (typeChild.type === "type_identifier") return typeChild.text;
      if (typeChild.type === "pointer_type") {
        const ti = typeChild.namedChildren.find((c) => c.type === "type_identifier");
        if (ti) return ti.text;
      }
    }
  }
  return null;
}

function createStructNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  const name = node.childForFieldName("name")?.text
    ?? node.namedChildren.find((child) => child.type === "type_identifier")?.text
    ?? null;

  if (!name) {
    return null;
  }

  return {
    id: `${fileNodeId}:class:${node.startPosition.row + 1}:${name}`,
    label: "Class",
    properties: {
      name,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: /^[A-Z]/.test(name),
      isAbstract: false,
      visibility: goVisibility(name),
      fields: JSON.stringify(structFields(node.childForFieldName("type"))),
      ...typeParameters(node),
    },
  };
}

// `type Reader interface { Read(p []byte) (int, error); io.Closer }`: the
// method names and the embedded interfaces (types of a constraint union such
// as `~int | ~string` are not interfaces and are left out).
function createInterfaceNode(fileNodeId: string, node: SyntaxNode): GraphNode {
  const name = node.childForFieldName("name")!.text;
  const methods: string[] = [];
  const embeds: string[] = [];
  for (const element of node.childForFieldName("type")?.namedChildren ?? []) {
    if (element.type === "method_elem" || element.type === "method_spec") {
      const methodName = element.childForFieldName("name")?.text;
      if (methodName) methods.push(methodName);
    } else if (element.type === "type_elem" && element.namedChildren.length === 1) {
      const embedded = element.namedChildren[0]!;
      if (embedded.type === "type_identifier" || embedded.type === "qualified_type" || embedded.type === "generic_type") embeds.push(embedded.text);
    }
  }
  return {
    id: `${fileNodeId}:interface:${node.startPosition.row + 1}:${name}`,
    label: "Interface",
    properties: {
      name,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: /^[A-Z]/.test(name),
      methods: JSON.stringify(methods),
      embeds: JSON.stringify(embeds),
      ...typeParameters(node),
    },
  };
}

// `type ID = string` (an alias) and `type Count int` (a defined type).
function createTypeAliasNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  const name = node.childForFieldName("name")?.text;
  const type = node.childForFieldName("type")?.text;
  if (!name || !type) return null;
  return {
    id: `${fileNodeId}:type:${node.startPosition.row + 1}:${name}`,
    label: "TypeAlias",
    properties: {
      name,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: /^[A-Z]/.test(name),
      aliasOf: type,
      isAlias: node.type === "type_alias",
      ...typeParameters(node),
    },
  };
}

// `[K comparable, V any]` of a generic type or function, as written.
function typeParameters(node: SyntaxNode): { typeParameters?: string } {
  const list = node.childForFieldName("type_parameters");
  return list ? { typeParameters: list.text } : {};
}

// A struct's fields as [{name, type}]; an embedded field is named after its
// type (`*db.Store` → `Store`) and marked.
function structFields(struct: SyntaxNode | null): Array<{ name: string; type: string; embedded?: true }> {
  const fields: Array<{ name: string; type: string; embedded?: true }> = [];
  const list = struct?.namedChildren.find((child) => child.type === "field_declaration_list");
  for (const declaration of list?.namedChildren ?? []) {
    if (declaration.type !== "field_declaration") continue;
    const type = declaration.childForFieldName("type")?.text;
    if (!type) continue;
    const names = declaration.childrenForFieldName("name");
    if (names.length === 0) fields.push({ name: baseTypeName(type), type, embedded: true });
    for (const name of names) fields.push({ name: name.text, type });
  }
  return fields;
}

// `*db.Store[T]` → `Store`.
function baseTypeName(type: string): string {
  return type.replace(/^\*/u, "").replace(/\[.*$/u, "").split(".").pop()!;
}

// What the names in a function's scope are known to hold, from declarations
// the parser can see: the receiver and parameters, `var x T`, and `x := T{}`,
// `&T{}`, `new(T)` (a type) or `x := NewT()` (whatever NewT returns, found
// once every file is parsed). Other locals are known only to be locals (null).
type LocalType = { type: string } | { constructor: string };

function localTypes(functionNode: SyntaxNode): Map<string, LocalType | null> {
  const locals = new Map<string, LocalType | null>();
  const declare = (name: SyntaxNode, local: LocalType | null) => {
    if (name.type === "identifier" && name.text !== "_") locals.set(name.text, local);
  };
  for (const list of [functionNode.childForFieldName("receiver"), functionNode.childForFieldName("parameters")]) {
    for (const parameter of goParameters(list)) {
      if (parameter.name && parameter.type && !parameter.type.startsWith("...")) locals.set(parameter.name, { type: parameter.type });
    }
  }
  walkScoped(functionNode, (node) => {
    if (node.type === "var_spec") {
      const type = node.childForFieldName("type")?.text;
      const values = node.childForFieldName("value")?.namedChildren ?? [];
      node.childrenForFieldName("name").forEach((name, index) => declare(name, type ? { type } : valueType(values[index])));
    }
    if (node.type === "short_var_declaration") {
      const names = node.childForFieldName("left")?.namedChildren ?? [];
      const values = node.childForFieldName("right")?.namedChildren ?? [];
      // `x, err := NewT()`: one call yields every name, x its first result.
      const local = values.length === 1 && names.length > 1 ? valueType(values[0]) : null;
      names.forEach((name, index) => declare(name, local ? (index === 0 ? local : null) : values.length === names.length ? valueType(values[index]) : null));
    }
    if (node.type === "range_clause") {
      for (const name of node.childForFieldName("left")?.namedChildren ?? []) declare(name, null);
    }
  }, (node) => node.type === "func_literal");
  return locals;
}

function valueType(value: SyntaxNode | undefined): LocalType | null {
  if (!value) return null;
  if (value.type === "unary_expression" && value.childForFieldName("operator")?.text === "&") return valueType(value.childForFieldName("operand") ?? undefined);
  if (value.type === "composite_literal") {
    const type = value.childForFieldName("type");
    return type && type.type !== "slice_type" && type.type !== "map_type" && type.type !== "array_type" ? { type: type.text } : null;
  }
  if (value.type !== "call_expression") return null;
  const callee = value.childForFieldName("function");
  if (!callee) return null;
  if (callee.text === "new") {
    const type = value.childForFieldName("arguments")?.namedChildren[0];
    return type ? { type: type.text } : null;
  }
  return callee.type === "identifier" || callee.type === "selector_expression" ? { constructor: callee.text } : null;
}

function goVisibility(name: string): string {
  return /^[A-Z]/.test(name) ? "exported" : "unexported";
}

function createCallNodes(functionNodeId: string, node: SyntaxNode, locals: Map<string, LocalType | null>): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type !== "call_expression") {
      return;
    }

    const callExpression = analyzeMemberCallExpression(child.childForFieldName("function")?.text);
    if (!callExpression) {
      return;
    }

    const local = callExpression.receiver === null ? undefined : locals.get(callExpression.receiver.split(".")[0]!);
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
        ...(local === undefined ? {} : local === null ? { receiverIsLocal: true } : "type" in local ? { receiverType: local.type } : { receiverConstructor: local.constructor }),
      },
    });
  }, (child) => child.type === "function_declaration" || child.type === "method_declaration");

  return calls;
}

function extractFunctionName(node: SyntaxNode): string | null {
  if (node.type === "method_declaration") {
    return node.namedChildren.find((child) => child.type === "field_identifier")?.text ?? null;
  }

  return node.childForFieldName("name")?.text
    ?? node.namedChildren.find((child) => child.type === "identifier")?.text
    ?? null;
}
