import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { goParameters } from "../../languages/go/parser.js";

// A closure a framework calls (a route handler, a command's Run) as a
// Function of its own, named by where it is registered.
export function closureFunctionNode(fileNodeId: string, syntax: SyntaxNode, name: string): GraphNode {
  const line = syntax.startPosition.row + 1;
  return {
    id: `${fileNodeId}:function:${line}:${name}`,
    label: "Function",
    properties: {
      name,
      kind: "func_literal",
      methodKind: null,
      line,
      endLine: syntax.endPosition.row + 1,
      className: null,
      isExported: false,
      isAsync: false,
      isAbstract: false,
      visibility: "unexported",
      parameters: JSON.stringify(goParameters(syntax.childForFieldName("parameters"))),
      returnType: syntax.childForFieldName("result")?.text ?? null,
    },
  };
}

// Adds the closures (once each) and moves the calls in their bodies from the
// enclosing function to them.
export function addClosures(
  closures: Array<{ node: GraphNode; syntax: SyntaxNode }>,
  enclosingFunctionId: string,
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  callsById: Map<string, GraphNode>,
): void {
  for (const closure of closures) {
    if (nodes.some((node) => node.id === closure.node.id)) continue;
    nodes.push(closure.node);
    relationships.push({ from: fileNodeId, to: closure.node.id, type: "DEFINES_FUNCTION", properties: {} });
    const start = closure.syntax.startPosition;
    const end = closure.syntax.endPosition;
    for (const relationship of relationships) {
      if (relationship.type !== "CALLS" || relationship.from !== enclosingFunctionId) continue;
      const call = callsById.get(relationship.to);
      if (!call) continue;
      const line = Number(call.properties.line) - 1;
      const column = Number(call.properties.columnNumber);
      const inside = (line > start.row || (line === start.row && column >= start.column))
        && (line < end.row || (line === end.row && column < end.column));
      if (inside) relationship.from = closure.node.id;
    }
  }
}
