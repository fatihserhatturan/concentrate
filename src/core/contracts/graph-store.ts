import type { GraphNode, GraphRelationship } from "../graph/model.js";
import type { IQueryEngine } from "./query-engine.js";

/** A record of the stored graph as `IGraphStore.forEachRecord` hands it out; properties are the store's own, read-only. */
export type GraphRecordVisitor = {
  node?(label: string, id: string, properties: Readonly<Record<string, unknown>>): void;
  /** `type` is the stored (physical) relationship type, as in Cypher. */
  relationship?(type: string, from: string, to: string, properties: Readonly<Record<string, unknown>>): void;
};

/** A persisted code graph, rewritten as a whole by each scan. */
export interface IGraphStore extends IQueryEngine {
  reset(): Promise<void>;
  write(nodes: GraphNode[], relationships: GraphRelationship[]): Promise<void>;
  /**
   * Visit every node, then every relationship, of the latest graph without
   * building query rows: for readers that copy the whole graph (the UI's
   * index), where a `MATCH ... RETURN` row per record would double it.
   * Nodes come in insertion order, relationships grouped by source node;
   * properties hold only the columns that are set (a `RETURN n` row also
   * lists the unset ones as null).
   */
  forEachRecord(visitor: GraphRecordVisitor): Promise<void>;
}
