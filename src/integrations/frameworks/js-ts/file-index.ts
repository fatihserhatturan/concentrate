import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";

// Lookups over one file's language-level graph and syntax tree, shared by the
// route and entrypoint detectors.

export function stripStringQuotes(value: string): string {
  return value.replace(/^["'`]|["'`]$/g, "");
}

export function moduleLevelCallExpressions(programNode: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  for (const stmt of programNode.namedChildren) {
    if (stmt.type !== "expression_statement") continue;

    let expr = stmt.namedChildren[0];
    if (!expr) continue;
    if (expr.type === "await_expression") {
      expr = expr.namedChildren[0];
    }
    if (expr?.type === "call_expression") {
      calls.push(expr);
    }
  }
  return calls;
}

export type FunctionAstPair = { functionNodeId: string; astNode: SyntaxNode };

const scopeBoundaryTypes = new Set([
  "arrow_function",
  "class",
  "class_declaration",
  "function_declaration",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
]);

// Statement-level calls in a function's own body, including those nested in
// blocks (`if`, `try`), but not those of functions declared inside it.
export function functionBodyCallExpressions(functionNode: SyntaxNode): SyntaxNode[] {
  const body = functionNode.childForFieldName("body");
  if (body?.type !== "statement_block") return [];

  const calls: SyntaxNode[] = [];
  const visit = (node: SyntaxNode) => {
    for (const child of node.namedChildren) {
      if (scopeBoundaryTypes.has(child.type)) continue;
      if (child.type !== "expression_statement") {
        visit(child);
        continue;
      }
      let expr = child.namedChildren[0];
      if (expr?.type === "await_expression") expr = expr.namedChildren[0];
      if (expr?.type === "call_expression") calls.push(expr);
    }
  };
  visit(body);
  return calls;
}

// Variables declared in a scope (a function's own body, or the program) with
// a call initializer (`const app = fastify(opts)`, `var app = module.exports =
// express()`), by name, with the called expression's text. Functions declared
// inside the scope are not entered.
export function scopeCallInitializers(scopeNode: SyntaxNode): Map<string, string> {
  const body = scopeNode.type === "program" ? scopeNode : scopeNode.childForFieldName("body");
  const locals = new Map<string, string>();
  if (body?.type !== "statement_block" && body?.type !== "program") return locals;

  const visit = (node: SyntaxNode) => {
    for (const child of node.namedChildren) {
      if (scopeBoundaryTypes.has(child.type)) continue;
      if (child.type === "variable_declarator") {
        const name = child.childForFieldName("name");
        let value = child.childForFieldName("value");
        while (value?.type === "assignment_expression") value = value.childForFieldName("right");
        if (value?.type === "await_expression") value = value.namedChildren[0] ?? null;
        if (name?.type === "identifier" && (value?.type === "call_expression" || value?.type === "new_expression")) {
          const callee = value.childForFieldName(value.type === "new_expression" ? "constructor" : "function");
          if (callee && !locals.has(name.text)) locals.set(name.text, callee.text);
        }
      }
      visit(child);
    }
  };
  visit(body);
  return locals;
}

// Parameter names of a function, in order ("" for a destructured one).
export function functionParameterNames(functionNode: SyntaxNode): string[] {
  const params = functionNode.childForFieldName("parameters") ?? functionNode.childForFieldName("parameter");
  if (!params) return [];
  if (params.type === "identifier") return [params.text];

  return params.namedChildren.map((param) => {
    const pattern = param.type === "required_parameter" || param.type === "optional_parameter"
      ? param.childForFieldName("pattern")
      : param.type === "assignment_pattern" ? param.childForFieldName("left") : param;
    return pattern?.type === "identifier" ? pattern.text : "";
  });
}

// Unnamed functions exported as the module (`module.exports = function (fastify,
// opts, next) { … }`, `export default async (app) => { … }`), which have no
// Function node of their own.
export function anonymousExportedFunctions(programNode: SyntaxNode): SyntaxNode[] {
  const functions: SyntaxNode[] = [];
  for (const stmt of programNode.namedChildren) {
    let value: SyntaxNode | null = null;
    if (stmt.type === "expression_statement") {
      const expr = stmt.namedChildren[0];
      if (expr?.type === "assignment_expression" && /^(module\.)?exports$/.test(expr.childForFieldName("left")?.text ?? "")) {
        value = expr.childForFieldName("right");
      }
    } else if (stmt.type === "export_statement" && stmt.children.some((child) => child.type === "default")) {
      value = stmt.childForFieldName("value") ?? stmt.childForFieldName("declaration");
    }
    if ((value?.type === "function_expression" || value?.type === "arrow_function" || value?.type === "function_declaration")
      && !value.childForFieldName("name")) {
      functions.push(value);
    }
  }
  return functions;
}

export function indexFileFunctions(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): Map<string, string> {
  const fileFunctionIds = new Set(
    relationships
      .filter((rel) => rel.from === fileNodeId && rel.type === "DEFINES_FUNCTION")
      .map((rel) => rel.to),
  );

  const functions = new Map<string, string>();
  for (const node of nodes) {
    if (!fileFunctionIds.has(node.id) || node.label !== "Function") continue;
    const name = node.properties.name;
    if (typeof name === "string" && !functions.has(name)) {
      functions.set(name, node.id);
    }
  }
  return functions;
}

export function indexPassedToHandlers(relationships: GraphRelationship[]): Map<string, string> {
  const handlers = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "PASSED_TO" && !handlers.has(rel.to)) {
      handlers.set(rel.to, rel.from);
    }
  }
  return handlers;
}

// Every function passed inline to a call, by call node id and then by its
// (synthetic) name: `<app.use:arg0>` names the same thing at every `app.use`
// call of a file, so steps are looked up at their own call first.
export function indexPassedToFunctions(nodes: GraphNode[], relationships: GraphRelationship[]): Map<string, Map<string, string>> {
  const nameById = new Map(nodes.filter((node) => node.label === "Function").map((node) => [node.id, node.properties.name]));
  const functions = new Map<string, Map<string, string>>();
  for (const rel of relationships) {
    if (rel.type !== "PASSED_TO") continue;
    const name = nameById.get(rel.from);
    if (typeof name !== "string") continue;
    const byName = functions.get(rel.to) ?? new Map<string, string>();
    if (!byName.has(name)) byName.set(name, rel.from);
    functions.set(rel.to, byName);
  }
  return functions;
}

export function firstDecoratorArg(decoratorNode: GraphNode): string | null {
  const args = decoratorNode.properties.args;
  if (typeof args !== "string") return null;

  try {
    const parsed = JSON.parse(args) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null;
  } catch {
    return null;
  }
}
