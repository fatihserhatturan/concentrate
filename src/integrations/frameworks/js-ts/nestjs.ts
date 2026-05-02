import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createNestJsRouteGraph } from "../../../parsers/js-ts/routes.js";
import { GraphBuilder } from "../../../graph/builder.js";
import { addNestJsModuleRelationships } from "../../../scanner/resolution/nestjs-modules.js";
import { addInjectionRelationships } from "../../../scanner/resolution/injections.js";
import { addInstanceMethodResolutionRelationships } from "../../../scanner/resolution/instances.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Parse-time NestJS route semantic module.
// Converts @Controller + @Get/@Post/... decorator pairs into Route nodes
// using the language-level Decorator and Function nodes already present in
// the graph.
export function applyNestJsParseSemantics(
  fileNodeId: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): void {
  const result = createNestJsRouteGraph(fileNodeId, nodes, relationships);
  nodes.push(...result.nodes);
  relationships.push(...result.relationships);
}

// Post-parse NestJS module graph: resolves @Module({imports, providers,
// controllers, exports}) declarations into MODULE_IMPORTS / MODULE_PROVIDES /
// MODULE_CONTROLS / MODULE_EXPORTS relationships.
export const nestjsModulesContributor: ISemanticContributor = {
  contribute(graph) {
    addNestJsModuleRelationships(graph as unknown as GraphBuilder);
  },
};

// Post-parse constructor injection resolution: links @Injectable classes to
// the services they inject via constructor parameter properties.
export const nestjsInjectionContributor: ISemanticContributor = {
  contribute(graph) {
    addInjectionRelationships(graph as unknown as GraphBuilder);
  },
};

// Post-parse instance method resolution: resolves this.service.method() calls
// through variables initialized with `new ClassName()`.
export const instanceMethodContributor: ISemanticContributor = {
  contribute(graph) {
    addInstanceMethodResolutionRelationships(graph as unknown as GraphBuilder);
  },
};
