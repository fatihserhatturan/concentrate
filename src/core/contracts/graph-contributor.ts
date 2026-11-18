import type { GraphNode, GraphRelationship } from "../graph/model.js";

export interface IGraphContributor {
  readonly nodes: GraphNode[];
  readonly relationships: GraphRelationship[];
  addNode(node: GraphNode): void;
  addNodes(nodes: GraphNode[]): void;
  addRelationship(relationship: GraphRelationship): void;
  addRelationships(relationships: GraphRelationship[]): void;
  /** The node with this id. */
  node(id: string): GraphNode | undefined;
  /** Nodes with this label, in insertion order (read only). */
  nodesWithLabel(label: GraphNode["label"]): readonly GraphNode[];
  /** Relationships of this type, in insertion order (read only). */
  relationshipsOfType(type: GraphRelationship["type"]): readonly GraphRelationship[];
  /** Remove these relationships; never splice `relationships` directly. */
  removeRelationships(remove: ReadonlySet<GraphRelationship>): void;
}
