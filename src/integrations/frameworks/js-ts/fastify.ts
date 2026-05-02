import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../../graph/model.js";
import { createExpressKoaRouteGraph } from "../../../parsers/js-ts/routes.js";
import { GraphBuilder } from "../../../graph/builder.js";
import { resolveRouteFullPaths } from "../../../scanner/resolution/route-paths.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Parse-time Fastify route semantic module.
// Fastify shorthand methods (fastify.get, fastify.post, ...) and
// fastify.route({ ... }) object-form declarations are detected by the same
// underlying function that handles Express/Koa because they share the same
// method-call-style patterns.
export function applyFastifyParseSemantics(
  fileNodeId: string,
  programNode: Parser.SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): void {
  const result = createExpressKoaRouteGraph(fileNodeId, programNode, nodes, relationships);
  nodes.push(...result.nodes);
  relationships.push(...result.relationships);
}

// Post-parse route path resolution (resolves composed paths across mounts and
// constants). Applies to all HTTP frameworks including Fastify.
export const routePathContributor: ISemanticContributor = {
  contribute(graph) {
    resolveRouteFullPaths(graph as unknown as GraphBuilder);
  },
};
