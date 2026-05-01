import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../graph/model.js";
import { analyzeMemberCallExpression } from "../tree-sitter-utils.js";

type EntrypointCandidate = {
  node: GraphNode;
  callNodeId: string | null;
  handlerNames: string[];
};

const nestSchedulerDecorators = new Set(["Cron", "Interval", "Timeout"]);

export function createBackendEntrypointGraph(
  fileNodeId: string,
  programNode: Parser.SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const entrypointNodes: GraphNode[] = [];
  const entrypointRelationships: GraphRelationship[] = [];
  const functionsByName = indexFileFunctions(fileNodeId, nodes, relationships);
  const functionIdsByPassedToCallId = indexPassedToHandlers(relationships);

  for (const callExpr of moduleLevelCallExpressions(programNode)) {
    const candidate = createCallEntrypoint(fileNodeId, callExpr);
    if (!candidate) continue;

    entrypointNodes.push(candidate.node);
    entrypointRelationships.push({
      from: fileNodeId,
      to: candidate.node.id,
      type: "DECLARES_ENTRYPOINT",
      properties: {},
    });

    if (candidate.callNodeId) {
      const inlineHandlerId = functionIdsByPassedToCallId.get(candidate.callNodeId);
      if (inlineHandlerId) {
        entrypointRelationships.push({
          from: candidate.node.id,
          to: inlineHandlerId,
          type: "ENTRYPOINT_HANDLED_BY",
          properties: {},
        });
      }
    }

    for (const handlerName of candidate.handlerNames) {
      const functionId = functionsByName.get(handlerName);
      if (!functionId) continue;
      entrypointRelationships.push({
        from: candidate.node.id,
        to: functionId,
        type: "ENTRYPOINT_HANDLED_BY",
        properties: {},
      });
    }
  }

  entrypointRelationships.push(...createNestSchedulerEntrypoints(fileNodeId, nodes, relationships, entrypointNodes));

  return { nodes: entrypointNodes, relationships: entrypointRelationships };
}

function createCallEntrypoint(
  fileNodeId: string,
  callExpr: Parser.SyntaxNode,
): EntrypointCandidate | null {
  const parts = analyzeMemberCallExpression(callExpr.childForFieldName("function")?.text);
  if (!parts) return null;

  const args = callExpr.childForFieldName("arguments")?.namedChildren ?? [];
  const pattern = classifyEntrypointCall(parts.callee, parts.receiver);
  if (!pattern) return null;

  const trigger = extractEntrypointTrigger(args, pattern.kind);
  const handlerArgs = args.slice(pattern.handlerStartIndex);
  const handlerNames = handlerArgs
    .filter((arg) => arg.type === "identifier")
    .map((arg) => arg.text);
  const handlerName = handlerNames[0] ?? null;
  const row = callExpr.startPosition.row + 1;
  const column = callExpr.startPosition.column;
  const callNodeId = `${fileNodeId}:modulecall:${row}:${column}:${parts.expression}`;

  return {
    node: createEntrypointNode({
      fileNodeId,
      row,
      column,
      kind: pattern.kind,
      trigger,
      receiverName: parts.receiver?.split(".")[0] ?? null,
      library: pattern.library,
      handlerName,
    }),
    callNodeId,
    handlerNames,
  };
}

function createNestSchedulerEntrypoints(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  entrypointNodes: GraphNode[],
): GraphRelationship[] {
  const entrypointRelationships: GraphRelationship[] = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const rel of relationships) {
    if (rel.type !== "HAS_METHOD_DECORATOR") continue;

    const methodNode = nodeById.get(rel.from);
    const decoratorNode = nodeById.get(rel.to);
    if (methodNode?.label !== "Function" || decoratorNode?.label !== "Decorator") continue;

    const decoratorName = decoratorNode.properties.name;
    if (typeof decoratorName !== "string" || !nestSchedulerDecorators.has(decoratorName)) {
      continue;
    }

    const line = Number(decoratorNode.properties.line);
    const row = Number.isFinite(line) ? line : Number(methodNode.properties.line);
    const entrypointNode = createEntrypointNode({
      fileNodeId,
      row,
      column: 0,
      kind: "scheduler",
      trigger: firstDecoratorArg(decoratorNode),
      receiverName: null,
      library: "nestjs-schedule",
      handlerName: typeof methodNode.properties.name === "string" ? methodNode.properties.name : null,
    });

    entrypointNodes.push(entrypointNode);
    entrypointRelationships.push({
      from: fileNodeId,
      to: entrypointNode.id,
      type: "DECLARES_ENTRYPOINT",
      properties: {},
    });
    entrypointRelationships.push({
      from: entrypointNode.id,
      to: methodNode.id,
      type: "ENTRYPOINT_HANDLED_BY",
      properties: {},
    });
  }

  return entrypointRelationships;
}

function classifyEntrypointCall(
  callee: string,
  receiver: string | null,
): { kind: string; library: string; handlerStartIndex: number } | null {
  const rootReceiver = receiver?.split(".")[0] ?? null;

  if ((callee === "on" || callee === "once" || callee === "addListener") && receiver) {
    return {
      kind: rootReceiver === "io" || rootReceiver === "socket" ? "realtime" : "event",
      library: rootReceiver === "io" || rootReceiver === "socket" ? "socket.io" : "event-emitter",
      handlerStartIndex: 1,
    };
  }

  if (callee === "process" && receiver) {
    return {
      kind: "queue",
      library: "bull",
      handlerStartIndex: 1,
    };
  }

  if ((callee === "schedule" || callee === "scheduleJob") && receiver) {
    return {
      kind: "cron",
      library: callee === "scheduleJob" ? "node-schedule" : "node-cron",
      handlerStartIndex: 1,
    };
  }

  return null;
}

function extractEntrypointTrigger(args: Parser.SyntaxNode[], kind: string): string | null {
  const firstString = args.find((arg) => arg.type === "string");
  if (firstString) return stripStringQuotes(firstString.text);
  return kind === "queue" ? null : null;
}

function createEntrypointNode(input: {
  fileNodeId: string;
  row: number;
  column: number;
  kind: string;
  trigger: string | null;
  receiverName: string | null;
  library: string;
  handlerName: string | null;
}): GraphNode {
  const triggerIdPart = input.trigger ?? "<none>";
  return {
    id: `${input.fileNodeId}:entrypoint:${input.row}:${input.column}:${input.kind}:${triggerIdPart}`,
    label: "EntryPoint",
    properties: {
      kind: input.kind,
      trigger: input.trigger,
      receiverName: input.receiverName,
      library: input.library,
      line: input.row,
      handlerName: input.handlerName,
    },
  };
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

function indexPassedToHandlers(relationships: GraphRelationship[]): Map<string, string> {
  const handlers = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "PASSED_TO" && !handlers.has(rel.to)) {
      handlers.set(rel.to, rel.from);
    }
  }
  return handlers;
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

function stripStringQuotes(value: string): string {
  return value.replace(/^["'`]|["'`]$/g, "");
}
