import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createFastifyDecoratorRouteGraph, createFastifyRouteGraph } from "./route-graph.js";
import type { FunctionAstPair } from "./file-index.js";
import { resolveRouteFullPaths } from "./resolution/route-paths.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Parse-time Fastify route semantic module.
// Handles fastify.get/post/... shorthand calls, fastify.route({ ... })
// object-form declarations and fastify-decorators controllers.
export function applyFastifyParseSemantics(
  fileNodeId: string,
  programNode: SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  functionAstPairs: FunctionAstPair[] = [],
): void {
  const result = createFastifyRouteGraph(fileNodeId, programNode, nodes, relationships, functionAstPairs);
  const decoratorRoutes = createFastifyDecoratorRouteGraph(fileNodeId, programNode, nodes, relationships);
  nodes.push(...result.nodes, ...decoratorRoutes.nodes);
  relationships.push(...result.relationships, ...decoratorRoutes.relationships);
}

// Post-parse route path resolution (resolves composed paths across mounts and
// constants). Applies to all HTTP frameworks including Fastify.
export const routePathContributor: ISemanticContributor = {
  contribute(graph) {
    resolveRouteFullPaths(graph);
  },
};
