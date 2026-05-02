import type { GraphNode, GraphRelationship } from "../graph/model.js";

export interface IGraphContributor {
  readonly nodes: GraphNode[];
  readonly relationships: GraphRelationship[];
  addNode(node: GraphNode): void;
  addNodes(nodes: GraphNode[]): void;
  addRelationship(relationship: GraphRelationship): void;
  addRelationships(relationships: GraphRelationship[]): void;
}
