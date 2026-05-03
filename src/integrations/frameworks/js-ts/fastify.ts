import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createFastifyRouteGraph } from "../../../parsers/js-ts/routes.js";
import { GraphBuilder } from "../../../graph/builder.js";
import { resolveRouteFullPaths } from "../../../scanner/resolution/route-paths.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Parse-time Fastify route semantic module.
// Handles fastify.get/post/... shorthand calls and fastify.route({ ... })
// object-form declarations through the Fastify-specific route graph function.
export function applyFastifyParseSemantics(
  fileNodeId: string,
  programNode: Parser.SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): void {
  const result = createFastifyRouteGraph(fileNodeId, programNode, nodes, relationships);
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
