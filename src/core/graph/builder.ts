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

const NONE: readonly never[] = Object.freeze([]);

/**
 * The graph a scan builds. Besides the `nodes` and `relationships` arrays it
 * keeps lookups by id, label and type, so resolvers and contributors find what
 * they need without a pass (and a Map) over the whole graph each: on a large
 * repository those passes were hundreds of MB of short-lived objects apiece.
 * Add through the methods only; `removeRelationships` is the one way to take
 * relationships out.
 */
export class GraphBuilder {
  readonly nodes: GraphNode[] = [];
  readonly relationships: GraphRelationship[] = [];

  private readonly nodesById = new Map<string, GraphNode>();
  private readonly nodesByLabel = new Map<string, GraphNode[]>();
  private readonly relationshipsByType = new Map<string, GraphRelationship[]>();
  // Relationships already added, by hash. A bucket holds an array only on a hash
  // collision or when the same endpoints carry different properties.
  private readonly relationshipsByHash = new Map<number, GraphRelationship | GraphRelationship[]>();

  constructor(private readonly hash: RelationshipHash = hashRelationship) {}

  addNode(node: GraphNode): void {
    if (this.nodesById.has(node.id)) {
      return;
    }

    this.nodesById.set(node.id, node);
    this.nodes.push(node);
    const sameLabel = this.nodesByLabel.get(node.label);
    if (sameLabel) sameLabel.push(node);
    else this.nodesByLabel.set(node.label, [node]);
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
    const sameType = this.relationshipsByType.get(relationship.type);
    if (sameType) sameType.push(relationship);
    else this.relationshipsByType.set(relationship.type, [relationship]);
  }

  /** The node with this id (the first one added wins, as in `nodes`). */
  node(id: string): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  /** Nodes with this label, in the order they were added. Do not change the array. */
  nodesWithLabel(label: GraphNode["label"]): readonly GraphNode[] {
    return this.nodesByLabel.get(label) ?? NONE;
  }

  /** Relationships of this type, in the order they were added. Do not change the array. */
  relationshipsOfType(type: GraphRelationship["type"]): readonly GraphRelationship[] {
    return this.relationshipsByType.get(type) ?? NONE;
  }

  /** Remove these nodes from `nodes` and the lookups (their relationships are the caller's business). */
  removeNodes(remove: ReadonlySet<GraphNode>): void {
    if (remove.size === 0) return;
    const keep = (node: GraphNode) => !remove.has(node);
    let length = 0;
    for (const node of this.nodes) if (keep(node)) this.nodes[length++] = node;
    this.nodes.length = length;
    for (const node of remove) if (this.nodesById.get(node.id) === node) this.nodesById.delete(node.id);
    for (const [label, list] of this.nodesByLabel) {
      const remaining = list.filter(keep);
      if (remaining.length === list.length) continue;
      if (remaining.length === 0) this.nodesByLabel.delete(label);
      else this.nodesByLabel.set(label, remaining);
    }
  }

  /**
   * Remove these relationships from `relationships` and the type lookup. Like
   * splicing them out of `relationships` before, an identical relationship
   * added later is still treated as a duplicate.
   */
  removeRelationships(remove: ReadonlySet<GraphRelationship>): void {
    if (remove.size === 0) return;
    const keep = (relationship: GraphRelationship) => !remove.has(relationship);
    let length = 0;
    for (const relationship of this.relationships) if (keep(relationship)) this.relationships[length++] = relationship;
    this.relationships.length = length;
    for (const [type, list] of this.relationshipsByType) {
      const remaining = list.filter(keep);
      if (remaining.length === list.length) continue;
      if (remaining.length === 0) this.relationshipsByType.delete(type);
      else this.relationshipsByType.set(type, remaining);
    }
  }

  addRelationships(relationships: GraphRelationship[]): void {
    for (const relationship of relationships) {
      this.addRelationship(relationship);
    }
  }
}
