import path from "node:path";
import type { GraphNode, GraphRelationship } from "../../core/graph/model.js";
import { physicalRelationshipType } from "./physical-types.js";
import { withProvenance } from "./provenance.js";
import { nodeTableByLabel, relationshipTableByType, type PropertyType } from "./schema.js";

export type PropertyValue = string | number | boolean | null;
export type Properties = Readonly<Record<string, PropertyValue>>;

export class NodeRecord {
  readonly outgoing: RelationshipRecord[] = [];
  readonly incoming: RelationshipRecord[] = [];

  constructor(
    readonly id: string,
    readonly label: string,
    readonly properties: Properties,
  ) {}

  property(name: string): PropertyValue {
    if (name === "id") return this.id;
    return this.properties[name] ?? null;
  }
}

export class RelationshipRecord {
  constructor(
    /** Physical relationship table, e.g. `ACCESSES_DATA_FUNCTION`. */
    readonly type: string,
    readonly from: NodeRecord,
    readonly to: NodeRecord,
    readonly properties: Properties,
  ) {}

  property(name: string): PropertyValue {
    return this.properties[name] ?? null;
  }
}

/** Properties with a value index; the Cypher planner starts from these when it can. */
export const INDEXED_PROPERTIES = ["name", "relativePath", "method", "path"] as const;

/**
 * In-memory code graph: nodes by id and label, adjacency lists on each node,
 * and value indexes for INDEXED_PROPERTIES. Writes are validated against the
 * schema and follow the semantics of the Kuzu writer this replaces.
 */
export class MemoryGraph {
  private readonly nodesById = new Map<string, NodeRecord>();
  private readonly nodesByLabel = new Map<string, Set<NodeRecord>>();
  private readonly valueIndex = new Map<string, Map<PropertyValue, Set<NodeRecord>>>();
  private relationshipTotal = 0;

  get nodeCount(): number {
    return this.nodesById.size;
  }

  get relationshipCount(): number {
    return this.relationshipTotal;
  }

  node(id: string): NodeRecord | undefined {
    return this.nodesById.get(id);
  }

  nodes(): IterableIterator<NodeRecord> {
    return this.nodesById.values();
  }

  nodesWithLabel(label: string): ReadonlySet<NodeRecord> {
    return this.nodesByLabel.get(label) ?? EMPTY;
  }

  /** Nodes with `label` whose indexed `property` equals `value`; undefined if the property is not indexed. */
  lookup(label: string, property: string, value: PropertyValue): ReadonlySet<NodeRecord> | undefined {
    if (!(INDEXED_PROPERTIES as readonly string[]).includes(property)) return undefined;
    if (!nodeTableByLabel.get(label)?.properties[property]) return EMPTY;
    return this.valueIndex.get(indexKey(label, property))?.get(value) ?? EMPTY;
  }

  *relationships(): IterableIterator<RelationshipRecord> {
    for (const node of this.nodesById.values()) yield* node.outgoing;
  }

  clear(): void {
    this.nodesById.clear();
    this.nodesByLabel.clear();
    this.valueIndex.clear();
    this.relationshipTotal = 0;
  }

  addNode(label: string, id: string, properties: Record<string, unknown>): NodeRecord {
    const table = nodeTableByLabel.get(label);
    if (!table) {
      throw new Error(`Cannot write node ${id}: table ${label} does not exist`);
    }
    if (this.nodesById.has(id)) {
      throw new Error(`Cannot write node ${id}: duplicate primary key`);
    }
    const node = new NodeRecord(id, label, validateProperties(`node ${id}`, table.properties, properties));
    this.nodesById.set(id, node);
    let labelSet = this.nodesByLabel.get(label);
    if (!labelSet) this.nodesByLabel.set(label, labelSet = new Set());
    labelSet.add(node);
    for (const property of INDEXED_PROPERTIES) {
      const value = node.properties[property];
      if (value === undefined || value === null) continue;
      const key = indexKey(label, property);
      let values = this.valueIndex.get(key);
      if (!values) this.valueIndex.set(key, values = new Map());
      let set = values.get(value);
      if (!set) values.set(value, set = new Set());
      set.add(node);
    }
    return node;
  }

  /** Returns false, like Kuzu's `MATCH ... CREATE`, when an endpoint does not exist. */
  addRelationship(type: string, fromId: string, toId: string, properties: Record<string, unknown>): boolean {
    const table = relationshipTableByType.get(type);
    if (!table) {
      throw new Error(`Cannot write relationship ${fromId} -> ${toId}: table ${type} does not exist`);
    }
    const from = this.nodesById.get(fromId);
    const to = this.nodesById.get(toId);
    if (!from || !to) return false;
    if (from.label !== table.from || to.label !== table.to) {
      throw new Error(`Cannot write ${type} from ${from.label} ${fromId} to ${to.label} ${toId}: expected ${table.from} -> ${table.to}`);
    }
    const relationship = new RelationshipRecord(type, from, to, validateProperties(`${type} ${fromId} -> ${toId}`, table.properties, properties));
    from.outgoing.push(relationship);
    to.incoming.push(relationship);
    this.relationshipTotal += 1;
    return true;
  }

  /** Remove a node and every relationship touching it (`DETACH DELETE`). */
  deleteNode(node: NodeRecord): void {
    if (this.nodesById.get(node.id) !== node) return;
    const touching = new Set([...node.outgoing, ...node.incoming]);
    for (const relationship of touching) {
      if (relationship.from !== node) removeFrom(relationship.from.outgoing, relationship);
      if (relationship.to !== node) removeFrom(relationship.to.incoming, relationship);
    }
    this.relationshipTotal -= touching.size;
    node.outgoing.length = 0;
    node.incoming.length = 0;
    this.nodesById.delete(node.id);
    this.nodesByLabel.get(node.label)?.delete(node);
    for (const property of INDEXED_PROPERTIES) {
      const value = node.properties[property];
      if (value !== undefined && value !== null) {
        this.valueIndex.get(indexKey(node.label, property))?.get(value)?.delete(node);
      }
    }
  }

  /** Append a scanned graph. Physical relationship types are derived from the labels in this batch. */
  write(nodes: readonly GraphNode[], relationships: readonly GraphRelationship[]): void {
    for (const node of nodes) this.addNode(node.label, node.id, node.properties);
    const labels = new Map(nodes.map((node) => [node.id, node.label]));
    for (const relationship of relationships) {
      this.addRelationship(physicalRelationshipType(relationship, labels), relationship.from, relationship.to, withProvenance(relationship));
    }
  }
}

const EMPTY: ReadonlySet<NodeRecord> = new Set();

function indexKey(label: string, property: string): string {
  return `${label}\0${property}`;
}

function removeFrom(list: RelationshipRecord[], relationship: RelationshipRecord): void {
  const index = list.indexOf(relationship);
  if (index !== -1) list.splice(index, 1);
}

function validateProperties(
  owner: string,
  columns: Readonly<Record<string, PropertyType>>,
  properties: Record<string, unknown>,
): Properties {
  const result: Record<string, PropertyValue> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    const type = columns[name];
    if (!type) {
      throw new Error(`Cannot write ${owner}: unknown property ${name}`);
    }
    if (value !== null && !matchesType(type, value)) {
      throw new Error(`Cannot write ${owner}: property ${name} must be ${type}, got ${JSON.stringify(value)}`);
    }
    result[name] = value as PropertyValue;
  }
  return result;
}

function matchesType(type: PropertyType, value: unknown): boolean {
  switch (type) {
    case "STRING":
      return typeof value === "string";
    case "INT64":
      return typeof value === "number" && Number.isInteger(value);
    case "BOOLEAN":
      return typeof value === "boolean";
  }
}
