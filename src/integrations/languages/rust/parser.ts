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

// Node types whose children are items, members or statements: one with a
// syntax error is left out on its own, and the rest of the file is kept.
const statementParents = new Set([
  "source_file",
  "declaration_list",
  "block",
  "field_declaration_list",
  "enum_variant_list",
  "ordered_field_declaration_list",
  "match_block",
]);

export const rustParser: LanguageParser = {
  language: "rust",
  parse: (rootPath, filePath) => parseRustFile(rootPath, filePath),
};

async function parseRustFile(rootPath: string, filePath: string): Promise<ParsedSourceFile> {
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
        language: "rust",
      },
    },
  ];
  const relationships: GraphRelationship[] = [];

  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors("rust", source, statementParents);
  try {
    const importIds = new Set<string>();
    const impls: Array<{ type: string; trait: string; line: number }> = [];
    walk(tree.rootNode, (node) => {
      if (node.type === "use_declaration" || (node.type === "mod_item" && !node.childForFieldName("body"))) {
        for (const importNode of createImportNodes(fileNodeId, node, importIds)) {
          nodes.push(importNode);
          relationships.push({
            from: fileNodeId,
            to: importNode.id,
            type: "IMPORTS",
            properties: {},
          });
        }
      }

      if (node.type === "struct_item") {
        const classNode = createStructNode(fileNodeId, node);
        if (classNode) {
          nodes.push(classNode);
          relationships.push({ from: fileNodeId, to: classNode.id, type: "DEFINES_CLASS", properties: {} });
          addAttributes(nodes, relationships, classNode.id, "HAS_DECORATOR", node);
        }
      } else if (node.type === "enum_item") {
        const enumNode = createEnumNode(fileNodeId, node);
        if (enumNode) {
          nodes.push(enumNode);
          relationships.push({ from: fileNodeId, to: enumNode.id, type: "DEFINES_ENUM", properties: {} });
          addAttributes(nodes, relationships, enumNode.id, "ENUM_HAS_DECORATOR", node);
        }
      } else if (node.type === "trait_item") {
        const traitNode = createTraitNode(fileNodeId, node);
        if (traitNode) {
          nodes.push(traitNode);
          relationships.push({ from: fileNodeId, to: traitNode.id, type: "DEFINES_INTERFACE", properties: {} });
          addAttributes(nodes, relationships, traitNode.id, "INTERFACE_HAS_DECORATOR", node);
        }
      } else if (node.type === "type_item" && node.parent?.type !== "declaration_list") {
        const aliasNode = createTypeAliasNode(fileNodeId, node);
        if (aliasNode) {
          nodes.push(aliasNode);
          relationships.push({ from: fileNodeId, to: aliasNode.id, type: "DEFINES_TYPE_ALIAS", properties: {} });
        }
      } else if ((node.type === "const_item" || node.type === "static_item") && isModuleLevel(node)) {
        const variableNode = createVariableNode(fileNodeId, node);
        if (variableNode) {
          nodes.push(variableNode);
          relationships.push({ from: fileNodeId, to: variableNode.id, type: "DEFINES_VARIABLE", properties: {} });
        }
      } else if (node.type === "macro_definition") {
        const macroNode = createMacroNode(fileNodeId, node);
        if (macroNode) {
          nodes.push(macroNode);
          relationships.push({ from: fileNodeId, to: macroNode.id, type: "DEFINES_FUNCTION", properties: {} });
        }
      } else if (node.type === "impl_item") {
        const trait = node.childForFieldName("trait");
        const typeName = baseTypeName(node.childForFieldName("type"));
        const traitName = baseTypeName(trait);
        if (trait && typeName && traitName) {
          impls.push({ type: typeName, trait: traitName, line: node.startPosition.row + 1 });
        }
      }
    });

    if (impls.length > 0) nodes[0]!.properties.rustImpls = JSON.stringify(impls);

    // Second pass: process functions now that all structs are indexed.
    const classesByName = new Map(
      nodes
        .filter((n) => n.label === "Class")
        .map((n) => [String(n.properties.name), n.id]),
    );

    const isBinaryFile = /(^|\/)(main\.rs|build\.rs)$|(^|\/)(src\/bin|examples)\//u.test(relativePath.split(path.sep).join("/"));
    walk(tree.rootNode, (node) => {
      if (node.type !== "function_item") return;

      const owner = functionOwner(node);
      const classNodeId = owner?.kind === "impl" ? classesByName.get(owner.name) : undefined;

      const functionNode = createFunctionNode(fileNodeId, node, owner?.name);
      if (!functionNode) return;
      if (owner?.kind === "trait") functionNode.properties.methodKind = "trait-default";
      if (owner?.kind === "impl" && owner.trait) {
        functionNode.properties.methodKind = "trait-impl";
        functionNode.properties.implementsTrait = owner.trait;
      }
      const attributes = attributesOf(node);
      const testKind = attributes.some((attribute) => /(^|::)test$|^rstest$|^test_case$/u.test(attribute.name)) ? "test"
        : attributes.some((attribute) => attribute.name === "bench") ? "bench"
        : insideCfgTest(node) ? "helper" : null;
      if (testKind) functionNode.properties.testKind = testKind;

      nodes.push(functionNode);
      addAttributes(nodes, relationships, functionNode.id, "HAS_METHOD_DECORATOR", node);

      if (classNodeId) {
        relationships.push({ from: classNodeId, to: functionNode.id, type: "DEFINES_METHOD", properties: {} });
      } else {
        relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
      }

      // `fn main` of a binary and `#[tokio::main]` & co. run without a caller.
      const name = String(functionNode.properties.name);
      const runtime = attributes.find((attribute) => /(^|::)main$/u.test(attribute.name) && attribute.name !== "main");
      if (!owner && node.parent?.type === "source_file" && ((name === "main" && isBinaryFile) || runtime)) {
        const line = node.startPosition.row + 1;
        const entrypoint: GraphNode = {
          id: `${fileNodeId}:entrypoint:${line}:${node.startPosition.column}:main:<none>`,
          label: "EntryPoint",
          properties: {
            kind: relativePath.endsWith("build.rs") ? "build-script" : "main",
            trigger: runtime?.expression ?? null,
            receiverName: null,
            library: runtime ? runtimeLibrary(runtime.name) : "rust",
            line,
            handlerName: name,
          },
        };
        nodes.push(entrypoint);
        relationships.push(
          { from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} },
          { from: entrypoint.id, to: functionNode.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} },
        );
      }

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

// The impl block or trait a function sits in directly.
function functionOwner(node: SyntaxNode): { kind: "impl" | "trait"; name: string; trait?: string } | null {
  if (node.parent?.type !== "declaration_list") return null;
  const owner = node.parent.parent;
  if (owner?.type === "impl_item") {
    const name = baseTypeName(owner.childForFieldName("type"));
    if (!name) return null;
    const trait = baseTypeName(owner.childForFieldName("trait"));
    return { kind: "impl", name, ...(trait ? { trait } : {}) };
  }
  if (owner?.type === "trait_item") {
    const name = owner.childForFieldName("name")?.text;
    return name ? { kind: "trait", name } : null;
  }
  return null;
}

// `Foo<T>`, `&mut Foo`, `a::b::Foo` → `Foo`; null for tuples, arrays, `dyn` and the like.
function baseTypeName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "generic_type":
      return baseTypeName(node.childForFieldName("type"));
    case "scoped_type_identifier":
      return node.childForFieldName("name")?.text ?? null;
    case "reference_type":
      return baseTypeName(node.childForFieldName("type"));
    default:
      return null;
  }
}

// Items directly in a file or a `mod` (not in a function, impl or trait).
function isModuleLevel(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type === "source_file") return true;
  return parent?.type === "declaration_list" && parent.parent?.type === "mod_item";
}

type RustAttribute = { name: string; expression: string; args: string[] };

// The `#[…]` attributes written right before an item.
function attributesOf(node: SyntaxNode): RustAttribute[] {
  const attributes: RustAttribute[] = [];
  for (let sibling = node.previousNamedSibling; sibling && (sibling.type === "attribute_item" || sibling.type === "line_comment" || sibling.type === "block_comment"); sibling = sibling.previousNamedSibling) {
    if (sibling.type !== "attribute_item") continue;
    const attribute = sibling.namedChildren.find((child) => child.type === "attribute");
    if (!attribute) continue;
    const name = attribute.namedChildren.find((child) => child.type === "identifier" || child.type === "scoped_identifier")?.text.replace(/\s+/gu, "");
    if (!name) continue;
    const list = attribute.childForFieldName("arguments");
    const value = attribute.childForFieldName("value");
    attributes.unshift({
      name,
      expression: sibling.text,
      args: list ? splitArguments(list.text.slice(1, -1)) : value ? [value.text] : [],
    });
  }
  return attributes;
}

function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === "\"") quote = false;
    } else if (char === "\"") {
      quote = true;
    } else if ("([{<".includes(char)) {
      depth += 1;
    } else if (")]}>".includes(char)) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function addAttributes(nodes: GraphNode[], relationships: GraphRelationship[], ownerId: string, relation: string, item: SyntaxNode): void {
  for (const attribute of attributesOf(item)) {
    const id = `${ownerId}:decorator:${item.startPosition.row + 1}:${attribute.name}`;
    if (nodes.some((candidate) => candidate.id === id)) continue;
    nodes.push({
      id,
      label: "Decorator",
      properties: { name: attribute.name, expression: attribute.expression, line: item.startPosition.row + 1, args: JSON.stringify(attribute.args) },
    });
    relationships.push({ from: ownerId, to: id, type: relation as GraphRelationship["type"], properties: {} });
  }
}

// Inside a `#[cfg(test)]` module (inline), however deeply.
function insideCfgTest(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "mod_item" && attributesOf(parent).some((attribute) => attribute.name === "cfg" && attribute.args.some((arg) => arg === "test"))) return true;
  }
  return false;
}

// `tokio::main` → tokio, `actix_web::main` → actix-web.
function runtimeLibrary(attribute: string): string {
  return attribute.split("::")[0]!.replaceAll("_", "-");
}

type UseEntry = { segments: string[]; alias: string | null; wildcard: boolean };

// One Import per imported path: `use a::{b, c as d, e::*}` is three.
function createImportNodes(fileNodeId: string, node: SyntaxNode, ids: Set<string>): GraphNode[] {
  const line = node.startPosition.row + 1;
  const inlineModules = enclosingInlineModules(node);
  const attribute = pathAttribute(node);
  const base: Record<string, unknown> = {
    specifier: node.text,
    line,
    ...(inlineModules.length > 0 ? { inlineModules: JSON.stringify(inlineModules) } : {}),
  };
  const make = (source: string, extra: Record<string, unknown>): GraphNode => {
    let id = `${fileNodeId}:import:${line}:${source}`;
    for (let n = 2; ids.has(id); n += 1) id = `${fileNodeId}:import:${line}:${source}#${n}`;
    ids.add(id);
    return { id, label: "Import", properties: { source, ...base, ...extra } } as GraphNode;
  };

  if (node.type === "mod_item") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return [];
    return [make(name, { isModule: true, ...(attribute ? { pathAttribute: attribute } : {}) })];
  }

  const argument = node.childForFieldName("argument");
  if (!argument) return [];
  const isPublic = node.namedChildren.some((child) => child.type === "visibility_modifier");
  return flattenUse(argument, []).map((entry) => make(entry.segments.join("::"), {
    ...(isPublic ? { isReExport: true } : {}),
    ...(entry.wildcard ? { isWildcard: true } : {}),
    ...(entry.alias && entry.alias !== "_" ? { alias: entry.alias } : {}),
  }));
}

function flattenUse(node: SyntaxNode, prefix: string[]): UseEntry[] {
  const segmentsOf = (path: SyntaxNode | null): string[] => (path ? path.text.replace(/\s+/gu, "").split("::").filter((part) => part !== "") : []);
  switch (node.type) {
    case "use_list":
      return node.namedChildren.flatMap((child) => flattenUse(child, prefix));
    case "scoped_use_list": {
      const list = node.childForFieldName("list");
      const next = [...prefix, ...segmentsOf(node.childForFieldName("path"))];
      return list ? flattenUse(list, next) : [];
    }
    case "use_as_clause": {
      const target = node.childForFieldName("path");
      return [{ segments: normalizeSelf([...prefix, ...segmentsOf(target)]), alias: node.childForFieldName("alias")?.text ?? null, wildcard: false }];
    }
    case "use_wildcard": {
      const target = node.namedChildren[0] ?? null;
      return [{ segments: [...prefix, ...segmentsOf(target)], alias: null, wildcard: true }];
    }
    case "self":
      return prefix.length > 0 ? [{ segments: prefix, alias: null, wildcard: false }] : [{ segments: ["self"], alias: null, wildcard: false }];
    default:
      return [{ segments: normalizeSelf([...prefix, ...segmentsOf(node)]), alias: null, wildcard: false }];
  }
}

// `a::b::self` names `a::b`.
function normalizeSelf(segments: string[]): string[] {
  return segments.length > 1 && segments[segments.length - 1] === "self" ? segments.slice(0, -1) : segments;
}

function enclosingInlineModules(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "mod_item" && parent.childForFieldName("body")) {
      const name = parent.childForFieldName("name")?.text;
      if (name) names.unshift(name);
    }
  }
  return names;
}

// `#[path = "x.rs"] mod y;`
function pathAttribute(node: SyntaxNode): string | null {
  for (let sibling = node.previousNamedSibling; sibling && (sibling.type === "attribute_item" || sibling.type === "line_comment" || sibling.type === "block_comment"); sibling = sibling.previousNamedSibling) {
    const match = /^#\[\s*path\s*=\s*"([^"]*)"\s*\]$/u.exec(sibling.text.trim());
    if (match) return match[1]!;
  }
  return null;
}

function createFunctionNode(fileNodeId: string, node: SyntaxNode, className?: string): GraphNode | null {
  const name = node.childForFieldName("name")?.text
    ?? node.namedChildren.find((child) => child.type === "identifier")?.text
    ?? null;

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
      isExported: rustVisibility(node) !== "private",
      isAsync: node.namedChildren.some((c) => c.type === "function_modifiers" && c.children.some((fc) => fc.type === "async")),
      isAbstract: false,
      visibility: rustVisibility(node),
      parameters: JSON.stringify(rustParameters(node.childForFieldName("parameters"))),
      returnType: returnTypeOf(node),
      ...typeParametersOf(node),
    },
  };
}

function typeParametersOf(node: SyntaxNode): { typeParameters?: string } {
  const list = node.childForFieldName("type_parameters");
  return list ? { typeParameters: list.text } : {};
}

function createStructNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  const name = node.childForFieldName("name")?.text
    ?? node.namedChildren.find((child) => child.type === "type_identifier")?.text
    ?? null;

  if (!name) {
    return null;
  }

  const fields: Array<{ name: string; type: string }> = [];
  const body = node.childForFieldName("body");
  if (body?.type === "field_declaration_list") {
    for (const field of body.namedChildren) {
      if (field.type !== "field_declaration") continue;
      const fieldName = field.childForFieldName("name")?.text;
      const type = field.childForFieldName("type")?.text;
      if (fieldName && type) fields.push({ name: fieldName, type });
    }
  } else if (body?.type === "ordered_field_declaration_list") {
    body.namedChildren
      .filter((field) => field.type !== "visibility_modifier" && field.type !== "attribute_item")
      .forEach((field, index) => fields.push({ name: String(index), type: field.text }));
  }

  return {
    id: `${fileNodeId}:class:${node.startPosition.row + 1}:${name}`,
    label: "Class",
    properties: {
      name,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: rustVisibility(node) !== "private",
      isAbstract: false,
      visibility: rustVisibility(node),
      ...(fields.length > 0 ? { fields: JSON.stringify(fields) } : {}),
      ...typeParametersOf(node),
    },
  };
}

function createEnumNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const variants = (node.childForFieldName("body")?.namedChildren ?? [])
    .filter((variant) => variant.type === "enum_variant")
    .map((variant) => variant.childForFieldName("name")?.text)
    .filter((variant): variant is string => variant !== undefined);
  return {
    id: `${fileNodeId}:enum:${node.startPosition.row + 1}:${name}`,
    label: "Enum",
    properties: {
      name,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: rustVisibility(node) !== "private",
      variants: JSON.stringify(variants),
      ...typeParametersOf(node),
    },
  };
}

// A trait is an Interface: its methods (with signatures) and supertraits.
function createTraitNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const methods: string[] = [];
  const signatures: Record<string, { parameters: Array<string | null>; returnType: string | null }> = {};
  for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
    if (member.type !== "function_item" && member.type !== "function_signature_item") continue;
    const methodName = member.childForFieldName("name")?.text;
    if (!methodName) continue;
    methods.push(methodName);
    signatures[methodName] = {
      parameters: rustParameters(member.childForFieldName("parameters")).map((parameter) => parameter.type),
      returnType: returnTypeOf(member),
    };
  }
  const embeds = (node.childForFieldName("bounds")?.namedChildren ?? [])
    .map((bound) => baseTypeName(bound))
    .filter((bound): bound is string => bound !== null);
  return {
    id: `${fileNodeId}:interface:${node.startPosition.row + 1}:${name}`,
    label: "Interface",
    properties: {
      name,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: rustVisibility(node) !== "private",
      methods: JSON.stringify(methods),
      methodSignatures: JSON.stringify(signatures),
      embeds: JSON.stringify(embeds),
      ...typeParametersOf(node),
    },
  };
}

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
      isExported: rustVisibility(node) !== "private",
      aliasOf: type,
      isAlias: true,
      ...typeParametersOf(node),
    },
  };
}

function createVariableNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  const name = node.childForFieldName("name")?.text;
  if (!name || name === "_") return null;
  const value = node.childForFieldName("value");
  const line = node.startPosition.row + 1;
  const literal = value?.type === "string_literal" && !value.text.includes("\\") ? value.text.slice(1, -1) : null;
  return {
    id: `${fileNodeId}:variable:${line}:${name}`,
    label: "Variable",
    properties: {
      name,
      kind: node.type === "const_item" ? "const" : "static",
      isExported: rustVisibility(node) !== "private",
      line,
      ...(literal === null ? {} : { stringValue: literal }),
    },
  };
}

// `macro_rules! name { … }` is a function the `name!(…)` calls resolve to.
function createMacroNode(fileNodeId: string, node: SyntaxNode): GraphNode | null {
  const name = node.childForFieldName("name")?.text ?? node.namedChildren.find((child) => child.type === "identifier")?.text;
  if (!name) return null;
  return {
    id: `${fileNodeId}:function:${node.startPosition.row + 1}:${name}`,
    label: "Function",
    properties: {
      name,
      kind: "macro_rules",
      methodKind: null,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      className: null,
      isExported: attributesOf(node).some((attribute) => attribute.name === "macro_export"),
      isAsync: false,
      isAbstract: false,
      visibility: attributesOf(node).some((attribute) => attribute.name === "macro_export") ? "pub" : "private",
      parameters: null,
      returnType: null,
    },
  };
}

// `(&self, a: u32, mut b: Vec<T>)` as [{name, type}].
function rustParameters(list: SyntaxNode | null): Array<{ name: string | null; type: string | null }> {
  const parameters: Array<{ name: string | null; type: string | null }> = [];
  for (const child of list?.namedChildren ?? []) {
    if (child.type === "self_parameter") {
      parameters.push({ name: "self", type: child.text.replace(/\bself\b/u, "Self").replace(/^mut\s+/u, "") });
    } else if (child.type === "parameter") {
      parameters.push({
        name: child.childForFieldName("pattern")?.text ?? null,
        type: child.childForFieldName("type")?.text ?? null,
      });
    }
  }
  return parameters;
}

function returnTypeOf(node: SyntaxNode): string | null {
  return node.childForFieldName("return_type")?.text ?? null;
}

function rustVisibility(node: SyntaxNode): string {
  const modifier = node.namedChildren.find((c) => c.type === "visibility_modifier")?.text;
  if (!modifier) {
    return "private";
  }

  if (modifier === "pub" || modifier === "pub(crate)" || modifier === "pub(super)") {
    return modifier;
  }

  return modifier.startsWith("pub") ? modifier : "private";
}

function createCallNodes(functionNodeId: string, node: SyntaxNode): GraphNode[] {
  const calls: GraphNode[] = [];

  walkScoped(node, (child) => {
    if (child.type !== "call_expression" && child.type !== "macro_invocation") {
      return;
    }

    const expression = child.type === "macro_invocation"
      ? child.namedChildren.find((candidate) => candidate.type === "identifier")?.text
      : child.childForFieldName("function")?.text;
    const callExpression = analyzeMemberCallExpression(expression);
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
  }, (child) => child.type === "function_item");

  return calls;
}
