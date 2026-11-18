import path from "node:path";
import type { GraphNode, GraphRelationship } from "../../core/graph/model.js";
import { physicalRelationshipType } from "./physical-types.js";
import { withProvenance } from "./provenance.js";
import { nodeTableByLabel, relationshipTableByType, type PropertyType } from "./schema.js";

export type PropertyValue = string | number | boolean | null;
export type Properties = Readonly<Record<string, PropertyValue>>;

/**
 * The adjacency list of a node without relationships. Frozen, so a push to it
 * throws instead of silently linking every node; `MemoryGraph.link` replaces it.
 */
const NO_RELATIONSHIPS: RelationshipRecord[] = Object.freeze([]) as unknown as RelationshipRecord[];

export class NodeRecord {
  /** Shared empty list until the first relationship; see `MemoryGraph.link`. */
  outgoing: RelationshipRecord[] = NO_RELATIONSHIPS;
  incoming: RelationshipRecord[] = NO_RELATIONSHIPS;

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
    return this.insertNode(new NodeRecord(id, label, validateProperties(`node ${id}`, table.properties, properties)));
  }

  private insertNode(node: NodeRecord): NodeRecord {
    const { id, label } = node;
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

  /**
   * Add a node read back from a snapshot. Its properties were validated when the
   * snapshot was written, so the parsed object is used as is, and the label comes
   * from the schema table so all nodes of a label share one string.
   */
  addTrustedNode(label: string, id: string, properties: Properties): NodeRecord {
    const table = nodeTableByLabel.get(label);
    if (!table) {
      throw new Error(`Cannot write node ${id}: table ${label} does not exist`);
    }
    if (this.nodesById.has(id)) {
      throw new Error(`Cannot write node ${id}: duplicate primary key`);
    }
    return this.insertNode(new NodeRecord(id, table.label, properties));
  }

  /** Trusted counterpart of addRelationship for snapshot loading; still checks the table and endpoint labels. */
  addTrustedRelationship(type: string, fromId: string, toId: string, properties: Properties): boolean {
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
    this.link(new RelationshipRecord(table.type, from, to, properties));
    return true;
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
    this.link(new RelationshipRecord(type, from, to, validateProperties(`${type} ${fromId} -> ${toId}`, table.properties, properties)));
    return true;
  }

  private link(relationship: RelationshipRecord): void {
    // A list that grows by `push` from empty keeps room for 16 entries, and
    // most nodes have one or two relationships: start each list at its exact
    // size instead (about 200 MB less on a loaded graph of 1.4 M nodes).
    const { from, to } = relationship;
    if (from.outgoing.length === 0) from.outgoing = [relationship];
    else from.outgoing.push(relationship);
    if (to.incoming.length === 0) to.incoming = [relationship];
    else to.incoming.push(relationship);
    this.relationshipTotal += 1;
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
    node.outgoing = NO_RELATIONSHIPS;
    node.incoming = NO_RELATIONSHIPS;
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

export function validateProperties(
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
