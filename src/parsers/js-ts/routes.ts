import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../graph/model.js";
import { analyzeMemberCallExpression } from "../tree-sitter-utils.js";

const routeMethods = new Set([
  "all",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "use",
]);

const nestMethodDecorators = new Map([
  ["All", "ALL"],
  ["Delete", "DELETE"],
  ["Get", "GET"],
  ["Head", "HEAD"],
  ["Options", "OPTIONS"],
  ["Patch", "PATCH"],
  ["Post", "POST"],
  ["Put", "PUT"],
]);

type RouteCandidate = {
  node: GraphNode;
  callNodeId: string;
  referencedHandlerNames: string[];
  objectHandlerNames: string[];
};

export function createExpressKoaRouteGraph(
  fileNodeId: string,
  programNode: Parser.SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const routeNodes: GraphNode[] = [];
  const routeRelationships: GraphRelationship[] = [];
  const functionsByName = indexFileFunctions(fileNodeId, nodes, relationships);
  const variablesByName = indexFileVariables(fileNodeId, nodes, relationships);
  const functionIdsByPassedToCallId = indexPassedToHandlers(relationships);

  for (const callExpr of moduleLevelCallExpressions(programNode)) {
    const routes = createRouteNodes(fileNodeId, callExpr);

    for (const route of routes) {
      routeNodes.push(route.node);
      routeRelationships.push({
        from: fileNodeId,
        to: route.node.id,
        type: "DECLARES_ROUTE",
        properties: {},
      });

      const inlineHandlerId = functionIdsByPassedToCallId.get(route.callNodeId);
      if (inlineHandlerId) {
        routeRelationships.push({
          from: route.node.id,
          to: inlineHandlerId,
          type: "ROUTE_HANDLED_BY",
          properties: {},
        });
      }

      for (const handlerName of route.referencedHandlerNames) {
        const functionId = functionsByName.get(handlerName);
        if (!functionId) continue;
        routeRelationships.push({
          from: route.node.id,
          to: functionId,
          type: "ROUTE_HANDLED_BY",
          properties: {},
        });
      }

      for (const handlerName of route.objectHandlerNames) {
        const functionId = functionsByName.get(handlerName);
        if (!functionId) continue;
        routeRelationships.push({
          from: route.node.id,
          to: functionId,
          type: "ROUTE_HANDLED_BY",
          properties: {},
        });
      }
    }

    routeRelationships.push(...createMountRelationships(callExpr, variablesByName, functionsByName));
  }

  return { nodes: routeNodes, relationships: routeRelationships };
}

export function createNestJsRouteGraph(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const routeNodes: GraphNode[] = [];
  const routeRelationships: GraphRelationship[] = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const classIdsByMethodId = indexClassIdsByMethodId(relationships);
  const controllerPathByClassId = indexNestControllerPaths(nodeById, relationships);

  for (const rel of relationships) {
    if (rel.type !== "HAS_METHOD_DECORATOR") continue;

    const methodNode = nodeById.get(rel.from);
    const decoratorNode = nodeById.get(rel.to);
    if (!methodNode || !decoratorNode || methodNode.label !== "Function" || decoratorNode.label !== "Decorator") {
      continue;
    }

    const decoratorName = decoratorNode.properties.name;
    if (typeof decoratorName !== "string" || !nestMethodDecorators.has(decoratorName)) {
      continue;
    }

    const classId = classIdsByMethodId.get(methodNode.id);
    if (!classId || !controllerPathByClassId.has(classId)) {
      continue;
    }

    const method = nestMethodDecorators.get(decoratorName)!;
    const routePath = joinRoutePaths(
      controllerPathByClassId.get(classId) ?? null,
      firstDecoratorArg(decoratorNode),
    );
    const line = Number(decoratorNode.properties.line);
    const routeNode = createRouteNode({
      fileNodeId,
      row: Number.isFinite(line) ? line : Number(methodNode.properties.line),
      column: 0,
      method,
      routePath,
      framework: "nestjs",
      handlerName: typeof methodNode.properties.name === "string" ? methodNode.properties.name : null,
    });

    routeNodes.push(routeNode);
    routeRelationships.push({
      from: fileNodeId,
      to: routeNode.id,
      type: "DECLARES_ROUTE",
      properties: {},
    });
    routeRelationships.push({
      from: routeNode.id,
      to: methodNode.id,
      type: "ROUTE_HANDLED_BY",
      properties: {},
    });
  }

  return { nodes: routeNodes, relationships: routeRelationships };
}

function createMountRelationships(
  callExpr: Parser.SyntaxNode,
  variablesByName: Map<string, string>,
  functionsByName: Map<string, string>,
): GraphRelationship[] {
  const parts = analyzeMemberCallExpression(callExpr.childForFieldName("function")?.text);
  if (!parts || !isMountCall(parts) || !isRouteReceiver(parts.receiver)) {
    return [];
  }

  const receiverName = parts.receiver?.split(".")[0];
  if (!receiverName) return [];

  const sourceVariableId = variablesByName.get(receiverName);
  if (!sourceVariableId) return [];

  const args = callExpr.childForFieldName("arguments")?.namedChildren ?? [];
  const mountPath = parts.callee === "register"
    ? extractObjectStringProperty(args.find((arg) => arg.type === "object"), "prefix")
    : extractLeadingPath(args);
  const mountedArgs = parts.callee === "register"
    ? args.slice(0, 1)
    : argsAfterLeadingPath(args);
  const line = callExpr.startPosition.row + 1;

  return mountedArgs.flatMap((arg) => {
    if (arg.type !== "identifier") return [];

    const targetId = variablesByName.get(arg.text) ?? functionsByName.get(arg.text);
    if (!targetId) return [];

    return [{
      from: sourceVariableId,
      to: targetId,
      type: "MOUNTS" as const,
      properties: {
        path: mountPath,
        line,
      },
    }];
  });
}

function createRouteNodes(
  fileNodeId: string,
  callExpr: Parser.SyntaxNode,
): RouteCandidate[] {
  const parts = analyzeMemberCallExpression(callExpr.childForFieldName("function")?.text);
  if (!parts || !isRouteReceiver(parts.receiver)) {
    return [];
  }

  if (parts.callee === "route" && isFastifyReceiver(parts.receiver)) {
    return createFastifyObjectRouteNodes(fileNodeId, callExpr, parts.expression);
  }

  if (!routeMethods.has(parts.callee)) {
    return [];
  }

  const args = callExpr.childForFieldName("arguments")?.namedChildren ?? [];
  const routePath = extractLeadingPath(args);
  const handlerArgs = argsAfterLeadingPath(args);
  const referencedHandlerNames = handlerArgs
    .filter((arg) => arg.type === "identifier")
    .map((arg) => arg.text);
  const handlerName = referencedHandlerNames[0] ?? null;
  const row = callExpr.startPosition.row + 1;
  const column = callExpr.startPosition.column;
  const method = parts.callee.toUpperCase();
  const pathIdPart = routePath ?? "<none>";
  const callNodeId = `${fileNodeId}:modulecall:${row}:${column}:${parts.expression}`;

  return [{
    node: createRouteNode({
      fileNodeId,
      row,
      column,
      method,
      routePath,
      framework: routeFramework(parts.receiver),
      handlerName,
    }),
    callNodeId,
    referencedHandlerNames,
    objectHandlerNames: [],
  }];
}

function createFastifyObjectRouteNodes(
  fileNodeId: string,
  callExpr: Parser.SyntaxNode,
  expression: string,
): RouteCandidate[] {
  const args = callExpr.childForFieldName("arguments")?.namedChildren ?? [];
  const config = args.find((arg) => arg.type === "object");
  if (!config) return [];

  const routePath = extractObjectStringProperty(config, "url") ?? extractObjectStringProperty(config, "path");
  const methods = extractObjectStringListProperty(config, "method");
  if (!routePath || methods.length === 0) return [];

  const handler = extractObjectProperty(config, "handler");
  const referencedHandlerNames = handler?.type === "identifier" ? [handler.text] : [];
  const objectHandlerNames = isFunctionExpressionNode(handler)
    ? [`<${expression}:${routePath}:handler>`]
    : [];
  const handlerName = referencedHandlerNames[0] ?? objectHandlerNames[0] ?? null;
  const row = callExpr.startPosition.row + 1;
  const column = callExpr.startPosition.column;
  const callNodeId = `${fileNodeId}:modulecall:${row}:${column}:${expression}`;

  return methods.map((method) => ({
    node: createRouteNode({
      fileNodeId,
      row,
      column,
      method: method.toUpperCase(),
      routePath,
      framework: "fastify",
      handlerName,
    }),
    callNodeId,
    referencedHandlerNames,
    objectHandlerNames,
  }));
}

function createRouteNode(input: {
  fileNodeId: string;
  row: number;
  column: number;
  method: string;
  routePath: string | null;
  framework: string;
  handlerName: string | null;
}): GraphNode {
  const pathIdPart = input.routePath ?? "<none>";

  return {
    id: `${input.fileNodeId}:route:${input.row}:${input.column}:${input.method}:${pathIdPart}`,
    label: "Route",
    properties: {
      method: input.method,
      path: input.routePath,
      line: input.row,
      framework: input.framework,
      handlerName: input.handlerName,
    },
  };
}

function extractObjectStringProperty(node: Parser.SyntaxNode | undefined, key: string): string | null {
  const value = node ? extractObjectProperty(node, key) : null;
  return value?.type === "string" ? stripStringQuotes(value.text) : null;
}

function extractObjectStringListProperty(node: Parser.SyntaxNode, key: string): string[] {
  const value = extractObjectProperty(node, key);
  if (!value) return [];

  if (value.type === "string") {
    return [stripStringQuotes(value.text)];
  }

  if (value.type === "array") {
    return value.namedChildren
      .filter((child) => child.type === "string")
      .map((child) => stripStringQuotes(child.text));
  }

  return [];
}

function extractObjectProperty(node: Parser.SyntaxNode, key: string): Parser.SyntaxNode | null {
  if (node.type !== "object") return null;

  for (const child of node.namedChildren) {
    if (child.type !== "pair") continue;
    const keyNode = child.childForFieldName("key");
    if (!keyNode || normalizeObjectKey(keyNode) !== key) continue;
    return child.childForFieldName("value");
  }

  return null;
}

function isFunctionExpressionNode(node: Parser.SyntaxNode | null): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression";
}

function normalizeObjectKey(node: Parser.SyntaxNode): string {
  return node.type === "string" ? stripStringQuotes(node.text) : node.text;
}

function extractLeadingPath(args: Parser.SyntaxNode[]): string | null {
  const pathArg = args.find((arg) => arg.type === "string");
  return pathArg ? stripStringQuotes(pathArg.text) : null;
}

function argsAfterLeadingPath(args: Parser.SyntaxNode[]): Parser.SyntaxNode[] {
  const pathArg = args.find((arg) => arg.type === "string");
  return pathArg ? args.slice(args.indexOf(pathArg) + 1) : args;
}

function isMountCall(parts: { callee: string; receiver: string | null }): boolean {
  return parts.callee === "use" || (parts.callee === "register" && isFastifyReceiver(parts.receiver));
}

function routeFramework(receiver: string | null): string {
  return isFastifyReceiver(receiver) ? "fastify" : "express-koa";
}

function isFastifyReceiver(receiver: string | null): boolean {
  if (!receiver) return false;
  const root = receiver.split(".")[0] ?? receiver;
  return root === "fastify";
}

function isRouteReceiver(receiver: string | null): boolean {
  if (!receiver) return false;
  const root = receiver.split(".")[0] ?? receiver;
  return root === "app" || root === "router" || root === "fastify" || /Router$/.test(root);
}

function stripStringQuotes(value: string): string {
  return value.replace(/^["'`]|["'`]$/g, "");
}

function moduleLevelCallExpressions(programNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const calls: Parser.SyntaxNode[] = [];
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

function indexFileFunctions(
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

function indexFileVariables(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): Map<string, string> {
  const fileVariableIds = new Set(
    relationships
      .filter((rel) => rel.from === fileNodeId && rel.type === "DEFINES_VARIABLE")
      .map((rel) => rel.to),
  );

  const variables = new Map<string, string>();
  for (const node of nodes) {
    if (!fileVariableIds.has(node.id) || node.label !== "Variable") continue;
    const name = node.properties.name;
    if (typeof name === "string" && !variables.has(name)) {
      variables.set(name, node.id);
    }
  }
  return variables;
}

function indexPassedToHandlers(relationships: GraphRelationship[]): Map<string, string> {
  const handlers = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "PASSED_TO" && !handlers.has(rel.to)) {
      handlers.set(rel.to, rel.from);
    }
  }
  return handlers;
}

function indexClassIdsByMethodId(relationships: GraphRelationship[]): Map<string, string> {
  const classIds = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "DEFINES_METHOD") {
      classIds.set(rel.to, rel.from);
    }
  }
  return classIds;
}

function indexNestControllerPaths(
  nodeById: Map<string, GraphNode>,
  relationships: GraphRelationship[],
): Map<string, string | null> {
  const controllerPaths = new Map<string, string | null>();
  for (const rel of relationships) {
    if (rel.type !== "HAS_DECORATOR") continue;

    const decoratorNode = nodeById.get(rel.to);
    if (decoratorNode?.label !== "Decorator" || decoratorNode.properties.name !== "Controller") {
      continue;
    }

    controllerPaths.set(rel.from, firstDecoratorArg(decoratorNode));
  }
  return controllerPaths;
}

function firstDecoratorArg(decoratorNode: GraphNode): string | null {
  const args = decoratorNode.properties.args;
  if (typeof args !== "string") return null;

  try {
    const parsed = JSON.parse(args) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null;
  } catch {
    return null;
  }
}

function joinRoutePaths(basePath: string | null, methodPath: string | null): string {
  const cleanBase = trimSlashes(basePath);
  const cleanMethod = trimSlashes(methodPath);
  const joined = [cleanBase, cleanMethod].filter(Boolean).join("/");
  return joined ? `/${joined}` : "/";
}

function trimSlashes(value: string | null): string {
  return value?.replace(/^\/+|\/+$/g, "") ?? "";
}
