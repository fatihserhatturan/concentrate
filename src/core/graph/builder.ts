import type { GraphNode, GraphRelationship } from "./model.js";

export type RelationshipHash = (relationship: GraphRelationship) => number;

function mixString(hash: number, value: string): number {
  let h = hash;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  // Separator so that ("ab", "c") and ("a", "bc") hash differently.
  return Math.imul(h ^ 0xff, 16777619);
}

// FNV-1a over from, type and to. Properties are not hashed; they are compared
// only when two relationships share this hash.
export function hashRelationship(relationship: GraphRelationship): number {
  let h = 2166136261;
  h = mixString(h, relationship.from);
  h = mixString(h, relationship.type);
  h = mixString(h, relationship.to);
  return h >>> 0;
}

function sameRelationship(a: GraphRelationship, b: GraphRelationship): boolean {
  return (
    a.from === b.from &&
    a.type === b.type &&
    a.to === b.to &&
    JSON.stringify(a.properties) === JSON.stringify(b.properties)
  );
}

export class GraphBuilder {
  readonly nodes: GraphNode[] = [];
  readonly relationships: GraphRelationship[] = [];

  private readonly nodeIds = new Set<string>();
  // Relationships already added, by hash. A bucket holds an array only on a hash
  // collision or when the same endpoints carry different properties.
  private readonly relationshipsByHash = new Map<number, GraphRelationship | GraphRelationship[]>();

  constructor(private readonly hash: RelationshipHash = hashRelationship) {}

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
    const key = this.hash(relationship);
    const known = this.relationshipsByHash.get(key);
    if (known === undefined) {
      this.relationshipsByHash.set(key, relationship);
    } else if (Array.isArray(known)) {
      if (known.some((other) => sameRelationship(other, relationship))) {
        return;
      }
      known.push(relationship);
    } else {
      if (sameRelationship(known, relationship)) {
        return;
      }
      this.relationshipsByHash.set(key, [known, relationship]);
    }

    this.relationships.push(relationship);
  }

  addRelationships(relationships: GraphRelationship[]): void {
    for (const relationship of relationships) {
      this.addRelationship(relationship);
    }
  }
}
