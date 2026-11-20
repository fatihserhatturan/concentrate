import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createExpressKoaRouteGraph } from "./route-graph.js";
import type { FunctionAstPair } from "./file-index.js";
import { addImportedRouteHandlerRelationships } from "./resolution/route-handlers.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Parse-time Express/Koa route semantic module.
// Fastify route detection shares the same underlying function — the
// implementation treats all method-call-style HTTP frameworks uniformly.
// See fastify.ts for the Fastify-specific entry point.
export function applyExpressKoaParseSemantics(
  fileNodeId: string,
  programNode: SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  functionAstPairs: FunctionAstPair[] = [],
): void {
  const result = createExpressKoaRouteGraph(fileNodeId, programNode, nodes, relationships, functionAstPairs);
  nodes.push(...result.nodes);
  relationships.push(...result.relationships);
}

// Post-parse route handler resolution: links handlers and middleware imported
// from another file. Runs before the env-config and data-access contributors,
// which read ROUTE_HANDLED_BY.
export const routeHandlerContributor: ISemanticContributor = {
  id: "js-ts.express-koa-route-handlers",
  contribute(graph) {
    addImportedRouteHandlerRelationships(graph);
  },
};
