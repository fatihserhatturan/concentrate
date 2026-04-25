import type { GraphNode, GraphRelationship } from "./model.js";

export class GraphBuilder {
  readonly nodes: GraphNode[] = [];
  readonly relationships: GraphRelationship[] = [];

  private readonly nodeIds = new Set<string>();
  private readonly relationshipIds = new Set<string>();

  addNode(node: GraphNode): void {
    if (this.nodeIds.has(node.id)) {
      return;
    }

    this.nodeIds.add(node.id);
    this.nodes.push(node);
  }

  addNodes(nodes: GraphNode[]): void {
    for (const node of nodes) {
      this.addNode(node);
    }
  }

  addRelationship(relationship: GraphRelationship): void {
    const id = `${relationship.from}:${relationship.type}:${relationship.to}`;
    if (this.relationshipIds.has(id)) {
      return;
    }

    this.relationshipIds.add(id);
    this.relationships.push(relationship);
  }

  addRelationships(relationships: GraphRelationship[]): void {
    for (const relationship of relationships) {
      this.addRelationship(relationship);
    }
  }
}
