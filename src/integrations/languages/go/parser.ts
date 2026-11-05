import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTreeSkippingErrors, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import {
  analyzeMemberCallExpression,
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

// A function or method of the file with the syntax it was built from.
export type GoParsedFunction = { syntax: SyntaxNode; node: GraphNode };

// Parse-time semantics a framework layer adds to a Go file once its
// structure is built (routes, entrypoints): it may add nodes and
// relationships, and move calls to a function it adds.
export type GoParsePlugin = (file: {
  fileNodeId: string;
  relativePath: string;
  root: SyntaxNode;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  functions: GoParsedFunction[];
}) => void;

export function createGoParser(plugins: readonly GoParsePlugin[] = []): LanguageParser {
  return {
    language: "go",
    parse: (rootPath, filePath) => parseGoFile(rootPath, filePath, plugins),
  };
}

export const goParser: LanguageParser = createGoParser();

async function parseGoFile(rootPath: string, filePath: string, plugins: readonly GoParsePlugin[]): Promise<ParsedSourceFile> {
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

    // Package-level `var` and `const` (one node per name).
    for (const declaration of tree.rootNode.namedChildren) {
      if (declaration.type !== "var_declaration" && declaration.type !== "const_declaration") continue;
      const specs = declaration.descendantsOfType(declaration.type === "var_declaration" ? "var_spec" : "const_spec");
      for (const spec of specs) {
        const values = spec.childForFieldName("value")?.namedChildren ?? [];
        spec.childrenForFieldName("name").forEach((name, index) => {
          if (name.text === "_") return;
          const variable = createVariableNode(fileNodeId, declaration.type === "var_declaration" ? "var" : "const", name, values[index], spec.childForFieldName("type")?.text);
          nodes.push(variable);
          relationships.push({ from: fileNodeId, to: variable.id, type: "DEFINES_VARIABLE", properties: {} });
        });
      }
    }

    // descendantsOfType runs in the parser's wasm and keeps document order,
    // so it finds the same nodes as a walk without visiting every node in JS.
    for (const node of tree.rootNode.descendantsOfType(["import_spec", "type_spec", "type_alias"])) {
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
    }

    // Second pass: process functions and methods now that all structs are indexed.
    const classesByName = new Map(
      nodes
        .filter((n) => n.label === "Class")
        .map((n) => [String(n.properties.name), n.id]),
    );

    const functions: GoParsedFunction[] = [];
    for (const node of tree.rootNode.descendantsOfType(["function_declaration", "method_declaration"])) {

      const receiverTypeName = node.type === "method_declaration"
        ? extractGoReceiverTypeName(node)
        : null;
      const classNodeId = receiverTypeName ? classesByName.get(receiverTypeName) : undefined;
      const className = receiverTypeName ?? undefined;

      const functionNode = createFunctionNode(fileNodeId, node, className);
      if (!functionNode) continue;

      nodes.push(functionNode);
      functions.push({ syntax: node, node: functionNode });

      if (classNodeId) {
        relationships.push({ from: classNodeId, to: functionNode.id, type: "DEFINES_METHOD", properties: {} });
      } else {
        relationships.push({ from: fileNodeId, to: functionNode.id, type: "DEFINES_FUNCTION", properties: {} });
      }

      // `func main` of package main and `func init` run without a caller.
      const name = String(functionNode.properties.name);
      if (node.type === "function_declaration" && node.parent?.type === "source_file"
        && ((name === "main" && packageName === "main") || name === "init")) {
        const line = node.startPosition.row + 1;
        const entrypoint: GraphNode = {
          id: `${fileNodeId}:entrypoint:${line}:${node.startPosition.column}:${name}:<none>`,
          label: "EntryPoint",
          properties: { kind: name, trigger: null, receiverName: null, library: "go", line, handlerName: name },
        };
        nodes.push(entrypoint);
        relationships.push(
          { from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} },
          { from: entrypoint.id, to: functionNode.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} },
        );
      }
      const testKind = relativePath.endsWith("_test.go") && node.type === "function_declaration" ? goTestKind(name) : null;
      if (testKind) functionNode.properties.testKind = testKind;

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
    }

    // One root object for every plugin: they share what they ask it
    // (frameworks/go/scope.ts, cachedForRoot).
    const root = tree.rootNode;
    for (const plugin of plugins) plugin({ fileNodeId, relativePath: relativePath.replaceAll("\\", "/"), root, nodes, relationships, functions });

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
export function goParameters(list: SyntaxNode | null): Array<{ name: string | null; type: string | null }> {
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

  // `(s Store)`, `(s *Store)`, `(n Nullable[T])`, `(n *Nullable[T])`.
  for (const param of receiver.namedChildren) {
    if (param.type !== "parameter_declaration") continue;
    let type = param.childForFieldName("type");
    if (type?.type === "pointer_type") type = type.namedChildren[0] ?? null;
    if (type?.type === "generic_type") type = type.childForFieldName("type");
    if (type?.type === "type_identifier") return type.text;
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

function createVariableNode(fileNodeId: string, kind: "var" | "const", name: SyntaxNode, value: SyntaxNode | undefined, type: string | undefined): GraphNode {
  const line = name.startPosition.row + 1;
  const literal = value?.type === "interpreted_string_literal" || value?.type === "raw_string_literal" ? goStringValue(value) : null;
  // A package variable's type, for calls on it (`store.Get()`, `config.DB.Find()`).
  const local = kind === "var" ? (type ? { type } : valueType(value)) : null;
  return {
    id: `${fileNodeId}:variable:${line}:${name.text}`,
    label: "Variable",
    properties: {
      name: name.text,
      kind,
      isExported: /^[A-Z]/.test(name.text),
      line,
      ...(literal === null ? {} : { stringValue: literal }),
      ...(local === null ? {} : "type" in local ? { goType: local.type } : { goConstructor: local.constructor }),
    },
  };
}

// The text of a string literal; null when it has escapes the graph would
// have to interpret.
function goStringValue(node: SyntaxNode): string | null {
  if (node.type === "raw_string_literal") return node.text.slice(1, -1);
  const body = node.text.slice(1, -1);
  return body.includes("\\") ? null : body;
}

// `TestX`, `BenchmarkX`, `FuzzX` and `ExampleX` of a _test.go file, which
// `go test` runs: the name continues with an upper-case letter, a digit or
// `_` (or is the prefix alone).
function goTestKind(name: string): string | null {
  const match = /^(Test|Benchmark|Fuzz|Example)(?:$|[^a-z])/u.exec(name);
  return match ? match[1]!.toLowerCase() : null;
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
// type (`*db.Store` → `Store`) and marked, and an anonymous struct field
// (`User struct { … }`) has type `struct` and its own fields.
type StructField = { name: string; type: string; embedded?: true; fields?: StructField[] };

function structFields(struct: SyntaxNode | null): StructField[] {
  const fields: StructField[] = [];
  const list = struct?.namedChildren.find((child) => child.type === "field_declaration_list");
  for (const declaration of list?.namedChildren ?? []) {
    if (declaration.type !== "field_declaration") continue;
    const typeNode = declaration.childForFieldName("type");
    if (!typeNode) continue;
    const field = typeNode.type === "struct_type" ? { type: "struct", fields: structFields(typeNode) } : { type: typeNode.text };
    const names = declaration.childrenForFieldName("name");
    if (names.length === 0) fields.push({ name: baseTypeName(typeNode.text), ...field, embedded: true });
    for (const name of names) fields.push({ name: name.text, ...field });
  }
  return fields;
}

// `*db.Store[T]` → `Store`.
function baseTypeName(type: string): string {
  return type.replace(/^\*/u, "").replace(/\[.*$/u, "").split(".").pop()!;
}

// What the names in a function's scope are known to hold, from declarations
// the parser can see: the receiver and parameters, `var x T`, and `x := T{}`,
// `&T{}`, `new(T)`, `v.(T)` (a type) or `x := NewT()` (whatever NewT returns, found
// once every file is parsed). Other locals are known only to be locals (null).
export type LocalType = { type: string } | { constructor: string };

// The parse, the routes, entrypoints and env plugins all ask for a function's
// locals: they are read once per function of a tree. Callers must not change
// the map.
const localsByTree = new WeakMap<object, Map<string, ReadonlyMap<string, LocalType | null>>>();
export function localTypes(functionNode: SyntaxNode): ReadonlyMap<string, LocalType | null> {
  const tree = functionNode.tree as object;
  let byFunction = localsByTree.get(tree);
  if (!byFunction) {
    byFunction = new Map();
    localsByTree.set(tree, byFunction);
  }
  const key = `${functionNode.startIndex}:${functionNode.endIndex}:${functionNode.type}`;
  let locals = byFunction.get(key);
  if (!locals) {
    locals = readLocalTypes(functionNode);
    byFunction.set(key, locals);
  }
  return locals;
}

function readLocalTypes(functionNode: SyntaxNode): Map<string, LocalType | null> {
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
      const local = values.length === 1 && names.length > 1 ? onReceiver(valueType(values[0]), locals) : null;
      names.forEach((name, index) => declare(name, local ? (index === 0 ? local : null) : values.length === names.length ? onReceiver(valueType(values[index]), locals) : null));
    }
    if (node.type === "range_clause") {
      // `for _, c := range comments` over a `[]T` or `map[K]T`: c is a T.
      const names = node.childForFieldName("left")?.namedChildren ?? [];
      // Over a call's result (`range h.items.All()`, or a local holding it),
      // the element of the result: `(*Handler).items.All[]`.
      const right = node.childForFieldName("right");
      const ranged = right?.type === "identifier" ? locals.get(right.text) : right?.type === "call_expression" ? onReceiver(valueType(right), locals) : undefined;
      const element: LocalType | null = !ranged ? null : "type" in ranged
        ? (elementType(ranged.type) === null ? null : { type: elementType(ranged.type)! })
        : ranged.constructor.endsWith("[]") ? null : { constructor: `${ranged.constructor}[]` };
      names.forEach((name, index) => declare(name, index === 1 ? element : null));
    }
  }, (node) => node.type === "func_literal");
  return locals;
}

// `h.store.Get()` with h a local of a known type: `(*Handler).store.Get`,
// which the resolver follows through the type's fields to the method's
// result.
function onReceiver(local: LocalType | null, locals: ReadonlyMap<string, LocalType | null>): LocalType | null {
  if (!local || "type" in local) return local;
  const [root, ...rest] = local.constructor.split(".");
  const receiver = rest.length > 0 ? locals.get(root!) : undefined;
  return receiver && "type" in receiver ? { constructor: `(${receiver.type}).${rest.join(".")}` } : local;
}

// `[]T`, `[4]T`, `map[K]T` → `T`.
export function elementType(type: string): string | null {
  const slice = /^(?:\[\d*\])+(.+)$/u.exec(type);
  if (slice) return slice[1]!.startsWith("[") ? null : slice[1]!;
  const map = /^map\[[^\]]+\](.+)$/u.exec(type);
  return map ? map[1]! : null;
}

function valueType(value: SyntaxNode | undefined): LocalType | null {
  if (!value) return null;
  // `c.MustGet("user").(UserModel)`.
  if (value.type === "type_assertion_expression") {
    const type = value.childForFieldName("type");
    return type ? { type: type.text } : null;
  }
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

export function goVisibility(name: string): string {
  return /^[A-Z]/.test(name) ? "exported" : "unexported";
}

export function createCallNodes(functionNodeId: string, node: SyntaxNode, locals: ReadonlyMap<string, LocalType | null>): GraphNode[] {
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
    const chained = chainedReceiver(child, locals);
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
        ...chained !== undefined
          ? { receiverConstructor: chained }
          : local === undefined ? {} : local === null ? { receiverIsLocal: true } : "type" in local ? { receiverType: local.type } : { receiverConstructor: local.constructor },
      },
    });
  }, (child) => child.type === "function_declaration" || child.type === "method_declaration");

  return calls;
}

// `api.NewHandler(s).Register(v1)`: the receiver is the result of a call to a
// package function or to a method of a typed local (`h.store.Get(1).Name()`),
// written with a trailing `()` (`api.NewHandler()`, `(*Handler).store.Get()`)
// so the resolver can tell it from a local's constructor.
function chainedReceiver(call: SyntaxNode, locals: ReadonlyMap<string, LocalType | null>): string | undefined {
  const fn = call.childForFieldName("function");
  const operand = fn?.type === "selector_expression" ? fn.childForFieldName("operand") : null;
  if (operand?.type !== "call_expression") return undefined;
  const callee = operand.childForFieldName("function");
  if (!callee || (callee.type !== "identifier" && callee.type !== "selector_expression") || !/^\w+(?:\.\w+)*$/u.test(callee.text)) return undefined;
  const [root, ...rest] = callee.text.split(".");
  if (!locals.has(root!)) return `${callee.text}()`;
  const local = locals.get(root!);
  return local && "type" in local && rest.length > 0 ? `(${local.type}).${rest.join(".")}()` : undefined;
}

function extractFunctionName(node: SyntaxNode): string | null {
  if (node.type === "method_declaration") {
    return node.namedChildren.find((child) => child.type === "field_identifier")?.text ?? null;
  }

  return node.childForFieldName("name")?.text
    ?? node.namedChildren.find((child) => child.type === "identifier")?.text
    ?? null;
}
