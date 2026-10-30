import { indexOfNode, type SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ImportBinding } from "../../../core/graph/model.js";
import { analyzeMemberCallExpression } from "../../languages/tree-sitter-utils.js";
import {
  anonymousExportedFunctions,
  firstDecoratorArg,
  functionBodyCallExpressions,
  functionParameterNames,
  scopeCallInitializers,
  indexFileFunctions,
  indexPassedToFunctions,
  indexPassedToHandlers,
  moduleLevelCallExpressions,
  stripStringQuotes,
  type FunctionAstPair,
} from "./file-index.js";

type FrameworkFilter = "express-koa" | "fastify";

// A route call inside a function body: the function, and the receivers that
// count as an app there (its own parameter or local, see functionRouteReceivers)
// with the framework each belongs to.
// The function has no node when it is an unnamed module export.
type FunctionRouteScope = {
  functionNodeId: string | null;
  receivers: Map<string, FrameworkFilter>;
};

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
  lifecycleSteps: RouteLifecycleStep[];
};

export type RouteLifecycleStep = {
  name: string;
  role: string;
  scope: string;
  hook: string | null;
  orderIndex: number;
};

// Route references that did not resolve to a function in the declaring file
// (`local`: the inline functions of the route's own call, by synthetic name):
// handler identifiers, and the full lifecycle step list when any step is unresolved.
export type PendingHandlerRefs = {
  handlers: string[];
  steps: RouteLifecycleStep[];
  local?: Record<string, string>;
};

export function createExpressKoaRouteGraph(
  fileNodeId: string,
  programNode: SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  functionAstPairs: FunctionAstPair[] = [],
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  return createHttpRouteGraph(fileNodeId, programNode, nodes, relationships, functionAstPairs, "express-koa");
}

export function createFastifyRouteGraph(
  fileNodeId: string,
  programNode: SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  functionAstPairs: FunctionAstPair[] = [],
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  return createHttpRouteGraph(fileNodeId, programNode, nodes, relationships, functionAstPairs, "fastify");
}

function createHttpRouteGraph(
  fileNodeId: string,
  programNode: SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  functionAstPairs: FunctionAstPair[],
  frameworkFilter: FrameworkFilter,
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const routeNodes: GraphNode[] = [];
  const routeRelationships: GraphRelationship[] = [];
  const functionsByName = indexFileFunctions(fileNodeId, nodes, relationships);
  const variablesByName = indexFileVariables(fileNodeId, nodes, relationships);
  const stringConstantsByName = indexFileStringConstants(fileNodeId, nodes, relationships);
  const functionIdsByPassedToCallId = indexPassedToHandlers(relationships);
  const passedFunctionsByCallId = indexPassedToFunctions(nodes, relationships);
  const functionIdsByName = functionsByName;
  const importedNames = indexFileNamedImports(fileNodeId, nodes, relationships);
  const mountIndexes: MountIndexes = {
    fileNodeId,
    variablesByName,
    functionsByName,
    functionIdsByPassedToCallId,
    stringConstantsByName,
    importBindingsByLocal: indexFileImportBindings(fileNodeId, nodes, relationships),
  };

  const moduleReceivers = factoryReceivers(programNode);
  const sites: Array<{ callExpr: SyntaxNode; scope: FunctionRouteScope | null }> = [
    ...moduleLevelCallExpressions(programNode).map((callExpr) => ({ callExpr, scope: null })),
  ];
  const functions = [
    ...functionAstPairs,
    ...anonymousExportedFunctions(programNode).map((astNode) => ({ functionNodeId: null, astNode })),
  ];
  for (const { functionNodeId, astNode } of functions) {
    const receivers = functionRouteReceivers(astNode);
    if (receivers.size === 0) continue;
    const scope = { functionNodeId, receivers };
    sites.push(...functionBodyCallExpressions(astNode).map((callExpr) => ({ callExpr, scope })));
  }

  for (const { callExpr, scope } of sites) {
    const routes = createRouteNodes(fileNodeId, callExpr, stringConstantsByName, frameworkFilter, scope ?? moduleReceivers);

    for (const route of routes) {
      routeNodes.push(route.node);
      routeRelationships.push({
        from: fileNodeId,
        to: route.node.id,
        type: "DECLARES_ROUTE",
        properties: {},
      });

      // Synthetic names of inline functions repeat across calls of a file, so
      // the route's steps resolve against its own call's functions first.
      const localFunctionIds = localStepFunctionIds(
        passedFunctionsByCallId.get(route.callNodeId) ?? new Map<string, string>(),
        route.lifecycleSteps,
      );
      const stepFunctionIds = localFunctionIds.size > 0
        ? new Map([...functionIdsByName, ...localFunctionIds])
        : functionIdsByName;
      // The handler is the step with the handler role (the last argument, or
      // a `handler` property), not the first inline function, which may be a
      // middleware; a route without one (`use`) keeps its first inline
      // function. Steps named by an identifier are linked below with the
      // referenced names.
      const linkedByName = new Set([...route.referencedHandlerNames, ...route.objectHandlerNames]);
      const unlinkedStepId = (step: RouteLifecycleStep | undefined) => (
        step && !linkedByName.has(step.name) ? stepFunctionIds.get(step.name) : undefined
      );
      const handlerStep = route.lifecycleSteps.find((step) => step.role === "handler");
      const inlineHandlerId = handlerStep
        ? unlinkedStepId(handlerStep)
        : functionIdsByPassedToCallId.get(route.callNodeId) ?? unlinkedStepId(route.lifecycleSteps[0]);
      if (inlineHandlerId) {
        routeRelationships.push({
          from: route.node.id,
          to: inlineHandlerId,
          type: "ROUTE_HANDLED_BY",
          properties: {},
        });
      }

      const unresolvedHandlerNames: string[] = [];
      for (const handlerName of route.referencedHandlerNames) {
        const functionId = functionsByName.get(handlerName);
        if (!functionId) {
          if (importedNames.has(handlerName)) unresolvedHandlerNames.push(handlerName);
          continue;
        }
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

      // Handlers and middleware imported from another file resolve after the
      // parse (resolution/route-handlers.ts). The lifecycle chain is built
      // there in one piece so LIFECYCLE_PRECEDES links across both kinds.
      const hasUnresolvedSteps = route.lifecycleSteps.some((step) => (
        !stepFunctionIds.has(step.name) && importedNames.has(step.name)
      ));
      if (unresolvedHandlerNames.length > 0 || hasUnresolvedSteps) {
        const pending: PendingHandlerRefs = {
          handlers: unresolvedHandlerNames,
          steps: hasUnresolvedSteps ? route.lifecycleSteps : [],
          ...(hasUnresolvedSteps && localFunctionIds.size > 0 ? { local: Object.fromEntries(localFunctionIds) } : {}),
        };
        route.node.properties.pendingHandlerRefs = JSON.stringify(pending);
      }
      if (!hasUnresolvedSteps) {
        routeRelationships.push(...createLifecycleRelationships(route.node.id, route.lifecycleSteps, stepFunctionIds));
      }
    }

    if (!scope) {
      routeRelationships.push(...createMountRelationships(callExpr, moduleReceivers, mountIndexes, frameworkFilter));
    }
  }

  routeRelationships.push(...createChainedMountRelationships(programNode, mountIndexes, frameworkFilter));

  return { nodes: routeNodes, relationships: routeRelationships };
}

export function createNestJsRouteGraph(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  return createDecoratorRouteGraph(fileNodeId, nodes, relationships, {
    framework: "nestjs",
    methodOf: (decorator) => nestMethodDecorators.get(String(decorator.properties.name)) ?? null,
    isController: (decorator) => decorator.properties.name === "Controller",
    controllerPath: firstDecoratorArg,
    methodPath: firstDecoratorArg,
  });
}

// fastify-decorators controllers: `@Controller('/users')` or
// `@Controller({ route: '/users' })` on the class, `@GET('/:id')` or
// `@GET({ url: '/:id' })` on its methods. Only decorators imported from
// fastify-decorators count, so a local `GET` decorator is not a route.
export function createFastifyDecoratorRouteGraph(
  fileNodeId: string,
  programNode: SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const imported = indexFileImportedNames(fileNodeId, nodes, relationships, "fastify-decorators");
  if (imported.size === 0) return { nodes: [], relationships: [] };

  const stringConstantsByName = indexFileStringConstants(fileNodeId, nodes, relationships);
  const decoratorAsts = indexDecoratorAsts(programNode);
  const importedName = (decorator: GraphNode) => imported.get(String(decorator.properties.name)) ?? null;
  const decoratorPath = (key: string) => (decorator: GraphNode): string | null => {
    const literal = firstDecoratorArg(decorator);
    if (literal !== null) return literal;
    const call = decoratorAsts.get(`${decorator.properties.line}:${decorator.properties.name}`)?.namedChildren[0];
    const config = call?.type === "call_expression"
      ? call.childForFieldName("arguments")?.namedChildren.find((arg) => arg.type === "object")
      : undefined;
    return extractObjectPathProperty(config, key, stringConstantsByName)?.value ?? null;
  };

  return createDecoratorRouteGraph(fileNodeId, nodes, relationships, {
    framework: "fastify",
    methodOf: (decorator) => {
      const name = importedName(decorator);
      return name && fastifyMethodDecorators.has(name) ? name : null;
    },
    isController: (decorator) => importedName(decorator) === "Controller",
    controllerPath: decoratorPath("route"),
    methodPath: decoratorPath("url"),
  });
}

const fastifyMethodDecorators = new Set(["ALL", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

// How one framework declares routes with decorators: which method decorators
// name an HTTP method, which class decorator makes a controller, and where
// each takes its path.
type DecoratorRouteDialect = {
  framework: string;
  methodOf(decorator: GraphNode): string | null;
  isController(decorator: GraphNode): boolean;
  controllerPath(decorator: GraphNode): string | null;
  methodPath(decorator: GraphNode): string | null;
};

function createDecoratorRouteGraph(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  dialect: DecoratorRouteDialect,
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const routeNodes: GraphNode[] = [];
  const routeRelationships: GraphRelationship[] = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const classIdsByMethodId = indexClassIdsByMethodId(relationships);
  const controllerPathByClassId = indexControllerPaths(nodeById, relationships, dialect);

  for (const rel of relationships) {
    if (rel.type !== "HAS_METHOD_DECORATOR") continue;

    const methodNode = nodeById.get(rel.from);
    const decoratorNode = nodeById.get(rel.to);
    if (!methodNode || !decoratorNode || methodNode.label !== "Function" || decoratorNode.label !== "Decorator") {
      continue;
    }

    const method = dialect.methodOf(decoratorNode);
    if (!method) continue;

    const classId = classIdsByMethodId.get(methodNode.id);
    if (!classId || !controllerPathByClassId.has(classId)) {
      continue;
    }

    const routePath = joinRoutePaths(
      controllerPathByClassId.get(classId) ?? null,
      dialect.methodPath(decoratorNode),
    );
    const line = Number(decoratorNode.properties.line);
    const routeNode = createRouteNode({
      fileNodeId,
      row: Number.isFinite(line) ? line : Number(methodNode.properties.line),
      column: 0,
      method,
      routePath,
      pathExpression: routePath,
      receiverName: null,
      framework: dialect.framework,
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

// What mount relationships are built from: the file's declarations, and the
// local names its imports bind (`import users from './users'`,
// `const v2 = require('./v2')`), by local name.
type MountIndexes = {
  fileNodeId: string;
  variablesByName: Map<string, string>;
  functionsByName: Map<string, string>;
  functionIdsByPassedToCallId: Map<string, string>;
  stringConstantsByName: Map<string, string>;
  importBindingsByLocal: Map<string, { importId: string; imported: string }>;
};

function createMountRelationships(
  callExpr: SyntaxNode,
  moduleReceivers: Map<string, FrameworkFilter>,
  indexes: MountIndexes,
  frameworkFilter: FrameworkFilter,
): GraphRelationship[] {
  const parts = analyzeMemberCallExpression(callExpr.childForFieldName("function")?.text);
  const framework = parts ? moduleReceiverFramework(parts.receiver, moduleReceivers) : undefined;
  if (!parts || framework !== frameworkFilter || !isMountCall(parts.callee, framework)) {
    return [];
  }

  const receiverName = parts.receiver?.split(".")[0];
  if (!receiverName) return [];

  const sourceVariableId = indexes.variablesByName.get(receiverName);
  if (!sourceVariableId) return [];

  return mountRelationshipsFor(callExpr, parts.callee, parts.expression, sourceVariableId, indexes);
}

// Mounts made by a chain on a router created in place, at module level:
// `const api = Router().use(tags).use('/x', other)` (from the `api`
// variable) and `export default Router().use('/api', api)` (from the
// file's default export).
function createChainedMountRelationships(
  programNode: SyntaxNode,
  indexes: MountIndexes,
  frameworkFilter: FrameworkFilter,
): GraphRelationship[] {
  const relationships: GraphRelationship[] = [];
  const addChain = (expression: SyntaxNode | null, sourceVariableId: string | undefined) => {
    const chain = expression && sourceVariableId ? routerChain(expression) : null;
    if (!chain || chain.framework !== frameworkFilter) return;
    for (const call of chain.calls) {
      const property = call.childForFieldName("function")?.childForFieldName("property")?.text;
      if (!property || !isMountCall(property, chain.framework)) continue;
      relationships.push(...mountRelationshipsFor(call, property, property, sourceVariableId!, indexes));
    }
  };

  for (const stmt of programNode.namedChildren) {
    const declaration = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
    if (declaration?.type === "lexical_declaration" || declaration?.type === "variable_declaration") {
      for (const declarator of declaration.namedChildren) {
        const name = declarator.childForFieldName("name");
        if (declarator.type !== "variable_declarator" || name?.type !== "identifier") continue;
        let value = declarator.childForFieldName("value");
        while (value?.type === "assignment_expression") value = value.childForFieldName("right");
        addChain(value, indexes.variablesByName.get(name.text));
      }
    } else if (stmt.type === "export_statement" && stmt.children.some((child) => child.type === "default")) {
      addChain(stmt.childForFieldName("value"), indexes.variablesByName.get("default"));
    }
  }
  return relationships;
}

// `Router().use(a).use(b)`: the chained calls, outermost first, when the
// chain starts at an app or router factory.
function routerChain(expression: SyntaxNode): { calls: SyntaxNode[]; framework: FrameworkFilter } | null {
  const calls: SyntaxNode[] = [];
  let node = expression;
  while (node.type === "call_expression") {
    const object = node.childForFieldName("function");
    const base = object?.type === "member_expression" ? object.childForFieldName("object") : null;
    if (!base || (base.type !== "call_expression" && base.type !== "new_expression")) break;
    calls.push(node);
    node = base;
  }

  const factory = node.childForFieldName(node.type === "new_expression" ? "constructor" : "function");
  const framework = calls.length > 0 && factory ? appFactoryFramework(factory.text) : null;
  return framework ? { calls, framework } : null;
}

function mountRelationshipsFor(
  callExpr: SyntaxNode,
  callee: string,
  expression: string,
  sourceVariableId: string,
  indexes: MountIndexes,
): GraphRelationship[] {
  const args = callExpr.childForFieldName("arguments")?.namedChildren ?? [];
  const mountPathInfo = callee === "register"
    ? extractObjectPathProperty(args.find((arg) => arg.type === "object"), "prefix", indexes.stringConstantsByName)
    : extractLeadingPath(args, indexes.stringConstantsByName);
  const mountPath = mountPathInfo ?? { value: null, expression: null };
  const mountedArgs = callee === "register"
    ? args.slice(0, 1)
    : argsAfterLeadingPath(args);
  // The line of `.use` itself, which in a chain is not where the call starts.
  const property = callExpr.childForFieldName("function")?.childForFieldName("property");
  const line = (property ?? callExpr).startPosition.row + 1;

  return mountedArgs.flatMap((arg) => {
    const target = mountTarget(arg, callExpr, callee, expression, indexes);
    if (!target) return [];

    return [{
      from: sourceVariableId,
      to: target.id,
      type: "MOUNTS" as const,
      properties: {
        path: mountPath.value,
        pathExpression: mountPath.expression,
        line,
        // A router of another file: the target is the Import, resolved to
        // that file's exported router after the parse (resolution/route-paths.ts).
        ...(target.importedName ? { importedName: target.importedName } : {}),
      },
    }];
  });
}

function mountTarget(
  arg: SyntaxNode,
  callExpr: SyntaxNode,
  callee: string,
  expression: string,
  indexes: MountIndexes,
): { id: string; importedName?: string } | null {
  if (arg.type === "identifier") {
    const binding = indexes.importBindingsByLocal.get(arg.text);
    if (binding) return { id: binding.importId, importedName: binding.imported };
    const id = indexes.variablesByName.get(arg.text) ?? indexes.functionsByName.get(arg.text);
    return id ? { id } : null;
  }

  // app.use('/v1', require('./v1')): the Import the language parser made for that call.
  const source = requiredSource(arg);
  if (source) {
    return { id: `${indexes.fileNodeId}:import:${arg.startPosition.row + 1}:${source}`, importedName: "default" };
  }

  // fastify.register(async (instance) => { … }, { prefix }) mounts the inline plugin.
  if (isFunctionExpressionNode(arg) && callee === "register") {
    const id = indexes.functionIdsByPassedToCallId.get(callNodeIdFor(indexes.fileNodeId, null, callExpr, expression));
    return id ? { id } : null;
  }
  return null;
}

function requiredSource(node: SyntaxNode): string | null {
  if (node.type !== "call_expression" || node.childForFieldName("function")?.text !== "require") return null;
  const source = node.childForFieldName("arguments")?.namedChildren[0];
  return source?.type === "string" ? stripStringQuotes(source.text) : null;
}

function createRouteNodes(
  fileNodeId: string,
  callExpr: SyntaxNode,
  stringConstantsByName: Map<string, string>,
  frameworkFilter: FrameworkFilter,
  scopeOrModuleReceivers: FunctionRouteScope | Map<string, FrameworkFilter>,
): RouteCandidate[] {
  const parts = analyzeMemberCallExpression(callExpr.childForFieldName("function")?.text);
  if (!parts) return [];

  const scope = scopeOrModuleReceivers instanceof Map ? null : scopeOrModuleReceivers;
  const framework = scope
    ? scope.receivers.get(routeReceiverName(parts.receiver) ?? "")
    : moduleReceiverFramework(parts.receiver, scopeOrModuleReceivers as Map<string, FrameworkFilter>);
  if (framework !== frameworkFilter) {
    return [];
  }

  if (parts.callee === "route" && framework === "fastify") {
    return createFastifyObjectRouteNodes(fileNodeId, callExpr, parts.expression, stringConstantsByName, scope);
  }

  if (!routeMethods.has(parts.callee)) {
    return [];
  }

  const args = callExpr.childForFieldName("arguments")?.namedChildren ?? [];
  const routePathInfo = extractLeadingPath(args, stringConstantsByName);
  const routePath = routePathInfo.value;
  const handlerArgs = argsAfterLeadingPath(args);
  // Inside a function only a call with a path and a handler is a route, so a
  // getter like `app.get('env')` is not.
  if (scope && (routePathInfo.expression === null || handlerArgs.length === 0)) {
    return [];
  }
  const referencedHandlerNames = handlerArgs
    .filter((arg) => arg.type === "identifier")
    .map((arg) => arg.text);
  const handlerName = referencedHandlerNames[0] ?? null;
  const row = callExpr.startPosition.row + 1;
  const column = callExpr.startPosition.column;
  const method = parts.callee.toUpperCase();
  const callNodeId = callNodeIdFor(fileNodeId, scope, callExpr, parts.expression);
  const lifecycleSteps = createCallLifecycleSteps({
    args,
    handlerArgs,
    expression: parts.expression,
    routePath,
    method,
    framework,
    scope: lifecycleScope(parts.receiver, parts.callee),
  });

  return [{
    node: createRouteNode({
      fileNodeId,
      row,
      column,
      method,
      routePath,
      pathExpression: routePathInfo.expression,
      receiverName: routeReceiverName(parts.receiver),
      framework,
      handlerName,
      scopeFunctionId: scope?.functionNodeId ?? null,
    }),
    callNodeId,
    referencedHandlerNames,
    objectHandlerNames: [],
    lifecycleSteps,
  }];
}

function createFastifyObjectRouteNodes(
  fileNodeId: string,
  callExpr: SyntaxNode,
  expression: string,
  stringConstantsByName: Map<string, string>,
  scope: FunctionRouteScope | null,
): RouteCandidate[] {
  const args = callExpr.childForFieldName("arguments")?.namedChildren ?? [];
  const config = args.find((arg) => arg.type === "object");
  if (!config) return [];

  const routePathInfo = extractObjectPathProperty(config, "url", stringConstantsByName)
    ?? extractObjectPathProperty(config, "path", stringConstantsByName);
  const routePath = routePathInfo?.value ?? null;
  const methods = extractObjectStringListProperty(config, "method");
  if (!routePath || methods.length === 0) return [];

  const handler = extractObjectProperty(config, "handler");
  const referencedHandlerNames = handler?.type === "identifier" ? [handler.text] : [];
  const objectHandlerNames = isFunctionExpressionNode(handler)
    ? [`<${expression}:${routePath}:handler>`]
    : [];
  const handlerName = referencedHandlerNames[0] ?? objectHandlerNames[0] ?? null;
  const lifecycleSteps = createFastifyObjectLifecycleSteps(config, expression, routePath);
  const row = callExpr.startPosition.row + 1;
  const column = callExpr.startPosition.column;
  const callNodeId = callNodeIdFor(fileNodeId, scope, callExpr, expression);

  return methods.map((method) => ({
    node: createRouteNode({
      fileNodeId,
      row,
      column,
      method: method.toUpperCase(),
      routePath,
      pathExpression: routePathInfo?.expression ?? null,
      receiverName: routeReceiverName(expression),
      framework: "fastify",
      handlerName,
      scopeFunctionId: scope?.functionNodeId ?? null,
    }),
    callNodeId,
    referencedHandlerNames,
    objectHandlerNames,
    lifecycleSteps,
  }));
}

// The functions passed to a route's call, keyed by the names its steps use.
// The parser names an inline function by the literal path it sees
// (`<app.get:arg1>` for `app.get(HEALTH, …)`), the route by the resolved one
// (`<app.get:/health:arg1>`), so a step also matches the function in the same
// argument or property position.
function localStepFunctionIds(passed: Map<string, string>, steps: RouteLifecycleStep[]): Map<string, string> {
  if (passed.size === 0) return passed;
  const local = new Map(passed);
  const byPosition = new Map([...passed].map(([name, id]) => [syntheticPosition(name), id]));
  for (const step of steps) {
    const position = syntheticPosition(step.name);
    const id = position ? byPosition.get(position) : undefined;
    if (id && !local.has(step.name)) local.set(step.name, id);
  }
  return local;
}

function syntheticPosition(name: string): string | null {
  return /^<.*:([^:>]+)>$/u.exec(name)?.[1] ?? null;
}

export function createLifecycleRelationships(
  routeNodeId: string,
  steps: RouteLifecycleStep[],
  functionsByName: Map<string, string>,
): GraphRelationship[] {
  const relationships: GraphRelationship[] = [];
  const resolvedSteps = steps
    .map((step) => ({ step, functionId: functionsByName.get(step.name) }))
    .filter((entry): entry is { step: RouteLifecycleStep; functionId: string } => Boolean(entry.functionId));

  for (const { step, functionId } of resolvedSteps) {
    relationships.push({
      from: routeNodeId,
      to: functionId,
      type: "ROUTE_LIFECYCLE_STEP",
      properties: {
        role: step.role,
        scope: step.scope,
        hook: step.hook,
        orderIndex: step.orderIndex,
      },
    });
  }

  for (let index = 0; index < resolvedSteps.length - 1; index += 1) {
    const current = resolvedSteps[index]!;
    const next = resolvedSteps[index + 1]!;
    relationships.push({
      from: current.functionId,
      to: next.functionId,
      type: "LIFECYCLE_PRECEDES",
      properties: {
        routeId: routeNodeId,
        scope: current.step.scope,
        orderIndex: index,
      },
    });
  }

  return relationships;
}

function createCallLifecycleSteps(input: {
  args: SyntaxNode[];
  handlerArgs: SyntaxNode[];
  expression: string;
  routePath: string | null;
  method: string;
  framework: string;
  scope: string;
}): RouteLifecycleStep[] {
  const steps: Omit<RouteLifecycleStep, "orderIndex">[] = [];

  for (const arg of input.handlerArgs) {
    if (input.framework === "fastify" && arg.type === "object") {
      steps.push(...fastifyHookFunctionNames(arg).map((entry) => ({
        name: entry.name,
        role: entry.key === "handler" ? "handler" : "middleware",
        scope: input.scope,
        hook: entry.key,
      })));
      continue;
    }

    steps.push(...extractLifecycleFunctionNames(arg, input.args, input.expression, input.routePath).map((name) => ({
      name,
      role: "middleware",
      scope: input.scope,
      hook: null,
    })));
  }

  if (input.method !== "USE") {
    const last = steps[steps.length - 1];
    if (last) {
      last.role = "handler";
      last.hook = last.hook ?? "handler";
    }
  }

  return steps.map((step, orderIndex) => ({ ...step, orderIndex }));
}

function createFastifyObjectLifecycleSteps(
  config: SyntaxNode,
  expression: string,
  routePath: string,
): RouteLifecycleStep[] {
  return fastifyHookFunctionNames(config, expression, routePath)
    .map((entry, orderIndex) => ({
      name: entry.name,
      role: entry.key === "handler" ? "handler" : "middleware",
      scope: "route",
      hook: entry.key,
      orderIndex,
    }));
}

function fastifyHookFunctionNames(
  objectNode: SyntaxNode,
  expression?: string,
  routePath?: string,
): Array<{ key: string; name: string }> {
  const names: Array<{ key: string; name: string }> = [];
  for (const key of fastifyLifecycleKeys) {
    const value = extractObjectProperty(objectNode, key);
    if (!value) continue;

    const extracted = extractLifecycleFunctionNames(value, [], expression, routePath, key);
    names.push(...extracted.map((name) => ({ key, name })));
  }
  return names;
}

function extractLifecycleFunctionNames(
  node: SyntaxNode,
  args: SyntaxNode[],
  expression?: string,
  routePath?: string | null,
  propertyName?: string,
): string[] {
  if (node.type === "identifier") {
    return [node.text];
  }

  if (node.type === "array") {
    return node.namedChildren.flatMap((child) => (
      extractLifecycleFunctionNames(child, args, expression, routePath, propertyName)
    ));
  }

  if (isFunctionExpressionNode(node) && expression) {
    // A named function expression (`app.use(function logRequests(…) {…})`)
    // has a Function node of its own under that name.
    const ownName = node.childForFieldName("name");
    if (ownName?.type === "identifier") return [ownName.text];

    if (propertyName) {
      return [routePath ? `<${expression}:${routePath}:${propertyName}>` : `<${expression}:${propertyName}>`];
    }

    const argIndex = indexOfNode(args, node);
    if (argIndex >= 0) {
      return [routePath ? `<${expression}:${routePath}:arg${argIndex}>` : `<${expression}:arg${argIndex}>`];
    }
  }

  return [];
}

const fastifyLifecycleKeys = [
  "onRequest",
  "preParsing",
  "preValidation",
  "preHandler",
  "preSerialization",
  "onSend",
  "onResponse",
  "onTimeout",
  "onError",
  "handler",
];

function createRouteNode(input: {
  fileNodeId: string;
  row: number;
  column: number;
  method: string;
  routePath: string | null;
  pathExpression: string | null;
  receiverName: string | null;
  framework: string;
  handlerName: string | null;
  scopeFunctionId?: string | null;
}): GraphNode {
  const pathIdPart = input.routePath ?? "<none>";

  return {
    id: `${input.fileNodeId}:route:${input.row}:${input.column}:${input.method}:${pathIdPart}`,
    label: "Route",
    properties: {
      method: input.method,
      path: input.routePath,
      fullPath: input.routePath,
      pathExpression: input.pathExpression,
      receiverName: input.receiverName,
      line: input.row,
      framework: input.framework,
      handlerName: input.handlerName,
      ...(input.scopeFunctionId ? { scopeFunctionId: input.scopeFunctionId } : {}),
    },
  };
}

// The id the language parser gives this call node: module-level calls are
// `…:modulecall:…`, calls in a function body are `<function>:call:…`.
function callNodeIdFor(fileNodeId: string, scope: FunctionRouteScope | null, callExpr: SyntaxNode, expression: string): string {
  const row = callExpr.startPosition.row + 1;
  const column = callExpr.startPosition.column;
  if (!scope) return `${fileNodeId}:modulecall:${row}:${column}:${expression}`;
  return `${scope.functionNodeId ?? fileNodeId}:call:${row}:${column}:${expression}`;
}

// Receivers that count as an app inside a function:
// - its first parameter, when the function is a Fastify plugin
//   (`(instance, opts, done)`, or passed inline to `.register(...)`) or the
//   parameter has an app name (`function app(fastify, config, done)`);
// - a local initialized by a call and with an app name
//   (`const app = fastify(opts)`).
// Variables of the enclosing module are not included.
function functionRouteReceivers(functionNode: SyntaxNode): Map<string, FrameworkFilter> {
  const receivers = new Map<string, FrameworkFilter>();
  const parameters = functionParameterNames(functionNode);
  const first = parameters[0];
  if (first) {
    if (isFastifyPluginFunction(functionNode, parameters)) receivers.set(first, "fastify");
    else if (isRouteReceiver(first)) receivers.set(first, routeFramework(first));
  }

  for (const [name, callee] of scopeCallInitializers(functionNode)) {
    if (receivers.has(name)) continue;
    const framework = appFactoryFramework(callee) ?? (isRouteReceiver(name) ? routeFramework(name) : null);
    if (framework) receivers.set(name, framework);
  }
  return receivers;
}

// Module-level variables created by an app or router factory, whatever their
// name: `const apiv1 = express.Router()`, `var main = express()`.
function factoryReceivers(programNode: SyntaxNode): Map<string, FrameworkFilter> {
  const receivers = new Map<string, FrameworkFilter>();
  for (const [name, callee] of scopeCallInitializers(programNode)) {
    const framework = appFactoryFramework(callee);
    if (framework) receivers.set(name, framework);
  }
  return receivers;
}

// The framework of a module-level receiver: from the factory that created it,
// else from its name (`app`, `router`, `fastify`, `…Router`).
function moduleReceiverFramework(receiver: string | null, moduleReceivers: Map<string, FrameworkFilter>): FrameworkFilter | undefined {
  const root = routeReceiverName(receiver);
  if (!root) return undefined;
  return moduleReceivers.get(root) ?? (isRouteReceiver(root) ? routeFramework(root) : undefined);
}

// The framework an app or router factory belongs to, from the called
// expression: `express()`, `express.Router()`, `Router()`, `new Koa()`,
// `new KoaRouter()` (also on the express module required in place), and
// `fastify()` / `Fastify()` or the fastify module required and called in one go.
function appFactoryFramework(callee: string): FrameworkFilter | null {
  const required = callee.match(/^require\(\s*["']([^"']+)["']\s*\)(\.Router)?$/);
  if (required) {
    if (required[1] === "fastify" && !required[2]) return "fastify";
    return required[1] === "express" ? "express-koa" : null;
  }
  if (/^fastify$/i.test(callee)) return "fastify";
  return /^(express|express\.Router|Router|Koa|KoaRouter)$/.test(callee) ? "express-koa" : null;
}

function isFastifyPluginFunction(functionNode: SyntaxNode, parameters: string[]): boolean {
  if (parameters.length === 3 && /^(done|next)$/.test(parameters[2]!)) return true;

  const args = functionNode.parent;
  const callee = args?.type === "arguments" ? args.parent?.childForFieldName("function") : null;
  return args?.namedChildren[0]?.id === functionNode.id && /\.register$/.test(callee?.text ?? "");
}


function extractObjectStringProperty(node: SyntaxNode | undefined, key: string): string | null {
  const value = node ? extractObjectProperty(node, key) : null;
  return value?.type === "string" ? stripStringQuotes(value.text) : null;
}

function extractObjectPathProperty(
  node: SyntaxNode | undefined,
  key: string,
  stringConstantsByName: Map<string, string>,
): { value: string | null; expression: string | null } | null {
  const value = node ? extractObjectProperty(node, key) : null;
  return value ? extractPathArgument(value, stringConstantsByName) : null;
}

function extractObjectStringListProperty(node: SyntaxNode, key: string): string[] {
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

function extractObjectProperty(node: SyntaxNode, key: string): SyntaxNode | null {
  if (node.type !== "object") return null;

  for (const child of node.namedChildren) {
    if (child.type !== "pair") continue;
    const keyNode = child.childForFieldName("key");
    if (!keyNode || normalizeObjectKey(keyNode) !== key) continue;
    return child.childForFieldName("value");
  }

  return null;
}

function isFunctionExpressionNode(node: SyntaxNode | null): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression";
}

function normalizeObjectKey(node: SyntaxNode): string {
  return node.type === "string" ? stripStringQuotes(node.text) : node.text;
}

function extractLeadingPath(
  args: SyntaxNode[],
  stringConstantsByName: Map<string, string>,
): { value: string | null; expression: string | null } {
  const pathArg = args.find((arg, index) => isPathArgument(arg, args, index, stringConstantsByName));
  return pathArg ? extractPathArgument(pathArg, stringConstantsByName) : { value: null, expression: null };
}

function argsAfterLeadingPath(args: SyntaxNode[]): SyntaxNode[] {
  const pathArg = args.find((arg, index) => (
    arg.type === "string" || (arg.type === "identifier" && index === 0 && args.length > 1)
  ));
  return pathArg ? args.slice(indexOfNode(args, pathArg) + 1) : args;
}

function isPathArgument(
  arg: SyntaxNode,
  args: SyntaxNode[],
  index: number,
  stringConstantsByName: Map<string, string>,
): boolean {
  if (arg.type === "string") return true;
  if (arg.type !== "identifier" || index !== 0) return false;
  return stringConstantsByName.has(arg.text) || args.length > 1;
}

function extractPathArgument(
  node: SyntaxNode,
  stringConstantsByName: Map<string, string>,
): { value: string | null; expression: string | null } {
  if (node.type === "string") {
    return {
      value: stripStringQuotes(node.text),
      expression: node.text,
    };
  }

  if (node.type === "identifier") {
    return {
      value: stringConstantsByName.get(node.text) ?? null,
      expression: node.text,
    };
  }

  return {
    value: null,
    expression: node.text,
  };
}

function isMountCall(callee: string, framework: FrameworkFilter): boolean {
  return callee === "use" || (callee === "register" && framework === "fastify");
}

function routeFramework(receiver: string | null): FrameworkFilter {
  return isFastifyReceiver(receiver) ? "fastify" : "express-koa";
}

function lifecycleScope(receiver: string | null, callee: string): string {
  if (callee !== "use") return "route";
  const root = receiver?.split(".")[0] ?? receiver;
  return root === "app" || root === "fastify" ? "application" : "router";
}

function routeReceiverName(receiver: string | null): string | null {
  return receiver?.split(".")[0] ?? null;
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

// Local names bound by the file's imports (named or default, ES or CommonJS),
// with the Import node and the imported name.
function indexFileImportBindings(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): Map<string, { importId: string; imported: string }> {
  const importIds = new Set(
    relationships
      .filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS")
      .map((rel) => rel.to),
  );

  const bindings = new Map<string, { importId: string; imported: string }>();
  for (const node of nodes) {
    if (!importIds.has(node.id) || node.label !== "Import" || typeof node.properties.bindings !== "string") continue;
    try {
      for (const binding of JSON.parse(node.properties.bindings) as ImportBinding[]) {
        if (binding.kind === "named" || binding.kind === "default") {
          bindings.set(binding.local, { importId: node.id, imported: binding.imported });
        }
      }
    } catch {
      continue;
    }
  }
  return bindings;
}

// Local names bound by named imports from `source`, mapped to the imported name.
function indexFileImportedNames(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  source: string,
): Map<string, string> {
  const importIds = new Set(
    relationships
      .filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS")
      .map((rel) => rel.to),
  );

  const names = new Map<string, string>();
  for (const node of nodes) {
    if (!importIds.has(node.id) || node.label !== "Import" || node.properties.source !== source) continue;
    if (typeof node.properties.bindings !== "string") continue;
    try {
      for (const binding of JSON.parse(node.properties.bindings) as ImportBinding[]) {
        if (binding.kind === "named") names.set(binding.local, binding.imported);
      }
    } catch {
      continue;
    }
  }
  return names;
}

// Local names bound by `import { a } from ...` or `const { a } = require(...)`.
function indexFileNamedImports(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): Set<string> {
  const importIds = new Set(
    relationships
      .filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS")
      .map((rel) => rel.to),
  );

  const names = new Set<string>();
  for (const node of nodes) {
    if (!importIds.has(node.id) || node.label !== "Import" || typeof node.properties.bindings !== "string") continue;
    try {
      const bindings = JSON.parse(node.properties.bindings) as ImportBinding[];
      for (const binding of bindings) {
        if (binding.kind === "named") names.add(binding.local);
      }
    } catch {
      continue;
    }
  }
  return names;
}

function indexFileStringConstants(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): Map<string, string> {
  const variableIds = new Set(
    relationships
      .filter((rel) => rel.from === fileNodeId && rel.type === "DEFINES_VARIABLE")
      .map((rel) => rel.to),
  );
  const constants = new Map<string, string>();

  for (const node of nodes) {
    if (!variableIds.has(node.id) || node.label !== "Variable") continue;
    const name = node.properties.name;
    const value = node.properties.stringValue;
    if (typeof name === "string" && typeof value === "string") {
      constants.set(name, value);
    }
  }

  return constants;
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

function indexControllerPaths(
  nodeById: Map<string, GraphNode>,
  relationships: GraphRelationship[],
  dialect: DecoratorRouteDialect,
): Map<string, string | null> {
  const controllerPaths = new Map<string, string | null>();
  for (const rel of relationships) {
    if (rel.type !== "HAS_DECORATOR") continue;

    const decoratorNode = nodeById.get(rel.to);
    if (decoratorNode?.label !== "Decorator" || !dialect.isController(decoratorNode)) {
      continue;
    }

    controllerPaths.set(rel.from, dialect.controllerPath(decoratorNode));
  }
  return controllerPaths;
}

// Decorator syntax nodes by line and name, as their Decorator nodes record them.
function indexDecoratorAsts(programNode: SyntaxNode): Map<string, SyntaxNode> {
  const decorators = new Map<string, SyntaxNode>();
  const visit = (node: SyntaxNode) => {
    for (const child of node.namedChildren) {
      if (child.type === "decorator") {
        const inner = child.namedChildren[0];
        const name = inner?.type === "call_expression" ? inner.childForFieldName("function")?.text : inner?.text;
        if (name) decorators.set(`${child.startPosition.row + 1}:${name}`, child);
        continue;
      }
      visit(child);
    }
  };
  visit(programNode);
  return decorators;
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
