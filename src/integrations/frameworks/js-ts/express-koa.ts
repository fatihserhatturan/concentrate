import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../../graph/model.js";
import { createExpressKoaRouteGraph } from "../../../parsers/js-ts/routes.js";

// Parse-time Express/Koa route semantic module.
// Fastify route detection shares the same underlying function — the
// implementation treats all method-call-style HTTP frameworks uniformly.
// See fastify.ts for the Fastify-specific entry point.
export function applyExpressKoaParseSemantics(
  fileNodeId: string,
  programNode: Parser.SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): void {
  const result = createExpressKoaRouteGraph(fileNodeId, programNode, nodes, relationships);
  nodes.push(...result.nodes);
  relationships.push(...result.relationships);
}
