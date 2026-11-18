import { readdir, stat } from "node:fs/promises";
import type { GraphNode, GraphRelationship } from "../../core/graph/model.js";
import type { GraphRecordVisitor, IGraphStore } from "../../core/contracts/graph-store.js";
import type { GraphStatsOptions, GraphStatsRow } from "../../core/contracts/query-engine.js";
import { executeCypher, type QueryParameters } from "./cypher/executor.js";
import { MemoryGraph } from "./graph.js";
import { acquireWriteLock } from "./lock.js";
import { commitScannedSnapshot, commitSnapshot, loadSnapshot, readHead, type Head } from "./persistence.js";
import { nodeLabels, SCHEMA_VERSION } from "./schema.js";

export type GraphStoreOpenOptions = {
  /** Wait for another writer to finish instead of failing at once. */
  retryLock?: boolean;
};

/**
 * The graph store: an in-memory graph loaded from a snapshot directory,
 * queried with our Cypher subset. Writers take the directory lock and commit
 * a new snapshot generation; readers pick up a newer generation on their
 * next call, so a running MCP server sees a finished scan.
 */
export class GraphStore implements IGraphStore {
  private pendingReset = false;
  /** The load in progress, shared by concurrent readers. */
  private loading: Promise<MemoryGraph> | null = null;
  /**
   * The arrays of the last streamed commit, until the first read needs a graph.
   * A query on this store right after a scan builds the graph from them, in
   * scan order like before; the caller owns these arrays anyway, so holding
   * them costs nothing while it does, and a store that is closed after the
   * write (the scan CLI) never builds a graph at all.
   */
  private scanned: { nodes: readonly GraphNode[]; relationships: readonly GraphRelationship[] } | null = null;

  private constructor(
    private readonly directory: string,
    /** Loaded on first use; always the graph of `head` when set. */
    private graph: MemoryGraph | null,
    private head: Head | null,
    private readonly retryLock: boolean,
  ) {}

  /** Open (or, on first write, create) the store at `directory`. Reading never creates it. */
  static async open(directory: string, options: GraphStoreOpenOptions = {}): Promise<GraphStore> {
    await assertStoreDirectory(directory);
    return new GraphStore(directory, null, await readHead(directory), options.retryLock ?? false);
  }

  /** Start from an empty graph. Committed by the next write or close. */
  async reset(): Promise<void> {
    this.graph = null;
    this.scanned = null;
    this.pendingReset = true;
  }

  async write(nodes: GraphNode[], relationships: GraphRelationship[]): Promise<void> {
    // After a reset the whole graph is replaced, so stream it to disk without a MemoryGraph copy.
    if (this.pendingReset) await this.commitReplacement(nodes, relationships);
    else await this.mutate((graph) => graph.write(nodes, relationships));
  }

  async query(cypher: string, params: QueryParameters = {}): Promise<unknown[]> {
    return executeCypher(await this.current(), cypher, params);
  }

  async forEachRecord(visitor: GraphRecordVisitor): Promise<void> {
    const graph = await this.current();
    if (visitor.node) for (const node of graph.nodes()) visitor.node(node.label, node.id, node.properties);
    if (visitor.relationship) {
      for (const relationship of graph.relationships()) {
        visitor.relationship(relationship.type, relationship.from.id, relationship.to.id, relationship.properties);
      }
    }
  }

  async stats(options: GraphStatsOptions = {}): Promise<GraphStatsRow[]> {
    const graph = await this.current();
    const count = (cypher: string, params: QueryParameters = {}) => executeCypher(graph, cypher, params)[0]?.count ?? 0;

    if (!options.packageName) {
      return nodeLabels.map((label) => ({ table: label, count: count(`MATCH (n:${label}) RETURN count(n) AS count`) }));
    }

    const packagePredicate = "p.name = $package OR p.relativePath = $package";
    const params = { package: options.packageName };
    const owned = (relationship: string, label: string, table: string) => ({
      table,
      count: count(`MATCH (p:Package)-[:PACKAGE_CONTAINS_FILE]->(f:File)-[:${relationship}]->(n:${label}) WHERE ${packagePredicate} RETURN count(n) AS count`, params),
    });
    return [
      { table: "Package", count: count(`MATCH (p:Package) WHERE ${packagePredicate} RETURN count(p) AS count`, params) },
      { table: "File", count: count(`MATCH (p:Package)-[:PACKAGE_CONTAINS_FILE]->(f:File) WHERE ${packagePredicate} RETURN count(f) AS count`, params) },
      owned("IMPORTS", "Import", "Import"),
      owned("DEFINES_FUNCTION", "Function", "Function"),
      owned("DEFINES_CLASS", "Class", "Class"),
      owned("DECLARES_ROUTE", "Route", "Route"),
    ];
  }

  async schemaVersion(): Promise<number | null> {
    if (this.pendingReset) return SCHEMA_VERSION;
    await this.refreshHead();
    return this.head?.schemaVersion ?? null;
  }

  async close(): Promise<void> {
    if (this.pendingReset) await this.commitReplacement([], []);
  }

  /** Commit a new graph that replaces the current one (after reset), streamed from the arrays. */
  private async commitReplacement(nodes: readonly GraphNode[], relationships: readonly GraphRelationship[]): Promise<void> {
    const release = await acquireWriteLock(this.directory, { wait: this.retryLock });
    try {
      const previous = await readHead(this.directory);
      this.head = await commitScannedSnapshot(this.directory, nodes, relationships, { schemaVersion: SCHEMA_VERSION, previous });
      this.graph = null;
      this.scanned = { nodes, relationships };
      this.pendingReset = false;
    } finally {
      await release();
    }
  }

  /** Apply a change under the writer lock and commit it as the next generation. */
  private async mutate<T>(change: (graph: MemoryGraph) => T): Promise<T> {
    const release = await acquireWriteLock(this.directory, { wait: this.retryLock });
    try {
      const latest = await readHead(this.directory);
      if (latest?.generation !== this.head?.generation) {
        this.graph = null;
        this.scanned = null;
      }
      const graph = this.graph ?? await this.loadGraph();
      let result: T;
      try {
        result = change(graph);
      } catch (error) {
        // Like a rolled-back transaction: drop the half-applied change; the next use reloads from disk.
        this.graph = null;
        throw error;
      }
      this.head = await commitSnapshot(this.directory, graph, { schemaVersion: SCHEMA_VERSION, previous: latest });
      return result;
    } finally {
      await release();
    }
  }

  /** The graph to read: empty after a local reset, otherwise the latest committed generation, loaded on demand. */
  private async current(): Promise<MemoryGraph> {
    if (this.pendingReset) return this.graph ??= new MemoryGraph();
    await this.refreshHead();
    return this.graph ?? await this.loadGraph();
  }

  /**
   * The graph of the current head, loaded once however many callers ask at
   * the same time (an MCP server or the UI runs several queries at once on a
   * fresh store; each loading its own copy would multiply the graph).
   */
  private loadGraph(): Promise<MemoryGraph> {
    this.loading ??= this.readGraph().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Build the graph of the current head: from the arrays of this store's last streamed commit, else from disk. */
  private async readGraph(): Promise<MemoryGraph> {
    const scanned = this.scanned;
    this.scanned = null;
    if (scanned) {
      const graph = new MemoryGraph();
      graph.write(scanned.nodes, scanned.relationships);
      return this.graph = graph;
    }
    ({ head: this.head, graph: this.graph } = await loadSnapshot(this.directory));
    return this.graph;
  }

  /** Follow the latest committed generation; a newer one drops the loaded graph. */
  private async refreshHead(): Promise<void> {
    const latest = await readHead(this.directory);
    if (latest?.generation === this.head?.generation) return;
    this.head = latest;
    this.graph = null;
    this.scanned = null;
  }
}

const STORE_ENTRIES = new Set(["HEAD.json", "LOCK", "segments"]);

/** Refuse a path that holds something else, most likely a Kuzu database from before the built-in store. */
async function assertStoreDirectory(directory: string): Promise<void> {
  let entries: string[];
  try {
    if (!(await stat(directory)).isDirectory()) throw kuzuDatabaseError(directory);
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.includes("HEAD.json")) return;
  const foreign = entries.filter((entry) => !STORE_ENTRIES.has(entry) && !entry.endsWith(".tmp"));
  if (foreign.some((entry) => entry.endsWith(".kz") || entry === ".lock" || entry.endsWith(".wal"))) throw kuzuDatabaseError(directory);
  if (foreign.length > 0) {
    throw new Error(`${directory} is not a Concentrate graph store (found ${foreign.slice(0, 3).join(", ")}); choose an empty or new directory`);
  }
}

function kuzuDatabaseError(directory: string): Error {
  return new Error(`${directory} is a Kuzu database from an older version of Concentrate; delete it and run concentrate scan again`);
}
