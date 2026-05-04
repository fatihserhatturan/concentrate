import { mkdir } from "node:fs/promises";
import path from "node:path";
import kuzu from "kuzu";
import type { Connection as KuzuConnection, Database as KuzuDatabase } from "kuzu";
import { formatProperties, quote } from "./kuzu-format.js";
import { physicalRelationshipType } from "./kuzu-relationships.js";
import { withKuzuRetry, type KuzuRetryOptions } from "./kuzu-retry.js";
import { closeResults } from "./kuzu-results.js";
import { readKuzuSchemaVersion, resetKuzuSchema } from "./kuzu-schema-management.js";
import { nodeLabels } from "./schema.js";
import type { GraphNode, GraphRelationship } from "../../core/graph/model.js";

export type KuzuWriteMode = "transaction" | "individual";

export type KuzuWriteOptions = {
  mode?: KuzuWriteMode;
};

export type KuzuOpenOptions = {
  retry?: KuzuRetryOptions | false;
};

export type KuzuStatsOptions = {
  packageName?: string;
};

export type KuzuPatchOptions = KuzuWriteOptions & {
  affectedFiles: string[];
};

export type KuzuPatchSummary = {
  affectedFiles: number;
  nodesWritten: number;
  relationshipsWritten: number;
};

export class KuzuGraphWriter {
  private constructor(
    private readonly database: KuzuDatabase,
    private readonly connection: KuzuConnection,
    private readonly retry: KuzuRetryOptions | false = false,
  ) {}

  static async open(databasePath: string, options: KuzuOpenOptions = {}): Promise<KuzuGraphWriter> {
    await mkdir(path.dirname(databasePath), { recursive: true });
    return withKuzuRetry(() => {
      const database = new kuzu.Database(databasePath) as KuzuDatabase;
      const connection = new kuzu.Connection(database) as KuzuConnection;
      return new KuzuGraphWriter(database, connection, options.retry ?? false);
    }, options.retry);
  }

  async reset(): Promise<void> {
    await resetKuzuSchema((statement) => this.execute(statement));
  }

  async schemaVersion(): Promise<number | null> {
    return readKuzuSchemaVersion((statement) => this.singleResult(statement));
  }

  async write(
    nodes: GraphNode[],
    relationships: GraphRelationship[],
    options: KuzuWriteOptions = {},
  ): Promise<void> {
    const mode = options.mode ?? "transaction";
    if (mode === "individual") {
      await this.writeIndividually(nodes, relationships);
      return;
    }

    await this.writeInTransaction(nodes, relationships);
  }

  async patch(
    nodes: GraphNode[],
    relationships: GraphRelationship[],
    options: KuzuPatchOptions,
  ): Promise<KuzuPatchSummary> {
    const affectedFileIds = options.affectedFiles.map((file) => `file:${toPosixPath(file)}`);
    const affectedNodeIds = new Set(
      nodes
        .filter((node) => isOwnedByAffectedFile(node.id, affectedFileIds))
        .map((node) => node.id),
    );
    const relationshipsToWrite = relationships.filter((relationship) => (
      isOwnedByAffectedFile(relationship.from, affectedFileIds)
      || isOwnedByAffectedFile(relationship.to, affectedFileIds)
    ));
    const relationshipEndpointIds = new Set<string>();
    for (const relationship of relationshipsToWrite) {
      relationshipEndpointIds.add(relationship.from);
      relationshipEndpointIds.add(relationship.to);
    }
    const nodesToWrite = nodes.filter((node) => (
      affectedNodeIds.has(node.id) || relationshipEndpointIds.has(node.id)
    ));
    const nodeLabelById = new Map(nodes.map((node) => [node.id, node.label]));
    const mode = options.mode ?? "transaction";
    if (mode === "individual") {
      const nodesWritten = await this.patchIndividually(affectedFileIds, nodesToWrite, relationshipsToWrite, nodeLabelById);
      return {
        affectedFiles: affectedFileIds.length,
        nodesWritten,
        relationshipsWritten: relationshipsToWrite.length,
      };
    }

    await this.execute("BEGIN TRANSACTION");
    try {
      const nodesWritten = await this.patchIndividually(affectedFileIds, nodesToWrite, relationshipsToWrite, nodeLabelById);
      await this.execute("COMMIT");
      return {
        affectedFiles: affectedFileIds.length,
        nodesWritten,
        relationshipsWritten: relationshipsToWrite.length,
      };
    } catch (error) {
      await this.rollbackTransaction();
      throw error;
    }
  }

  private async writeInTransaction(nodes: GraphNode[], relationships: GraphRelationship[]): Promise<void> {
    await this.execute("BEGIN TRANSACTION");
    try {
      await this.writeIndividually(nodes, relationships);
      await this.execute("COMMIT");
    } catch (error) {
      await this.rollbackTransaction();
      throw error;
    }
  }

  private async writeIndividually(nodes: GraphNode[], relationships: GraphRelationship[]): Promise<void> {
    for (const node of nodes) {
      await this.insertNode(node);
    }

    const nodeLabelById = new Map(nodes.map((node) => [node.id, node.label]));
    for (const relationship of relationships) {
      await this.insertRelationship(relationship, nodeLabelById);
    }
  }

  private async patchIndividually(
    affectedFileIds: string[],
    nodes: GraphNode[],
    relationships: GraphRelationship[],
    nodeLabelById: Map<string, GraphNode["label"]>,
  ): Promise<number> {
    for (const fileId of affectedFileIds) {
      await this.deleteFileOwnedNodes(fileId);
    }

    let nodesWritten = 0;
    for (const node of nodes) {
      if (await this.insertNodeIfMissing(node)) {
        nodesWritten += 1;
      }
    }

    for (const relationship of relationships) {
      await this.insertRelationship(relationship, nodeLabelById);
    }

    return nodesWritten;
  }

  async stats(options: KuzuStatsOptions = {}): Promise<Array<{ table: string; count: unknown }>> {
    if (options.packageName) {
      return this.packageStats(options.packageName);
    }

    const rows = [];

    for (const label of nodeLabels) {
      const result = await this.singleResult(`MATCH (n:${label}) RETURN count(n) AS count`);
      rows.push({ table: label, count: result[0]?.count ?? 0 });
    }

    return rows;
  }

  private async packageStats(packageName: string): Promise<Array<{ table: string; count: unknown }>> {
    const packagePredicate = `p.name = ${quote(packageName)} OR p.relativePath = ${quote(packageName)}`;
    const queries = [
      {
        table: "Package",
        query: `MATCH (p:Package) WHERE ${packagePredicate} RETURN count(p) AS count`,
      },
      {
        table: "File",
        query: `MATCH (p:Package)-[:PACKAGE_CONTAINS_FILE]->(f:File) WHERE ${packagePredicate} RETURN count(f) AS count`,
      },
      {
        table: "Import",
        query: `MATCH (p:Package)-[:PACKAGE_CONTAINS_FILE]->(f:File)-[:IMPORTS]->(i:Import) WHERE ${packagePredicate} RETURN count(i) AS count`,
      },
      {
        table: "Function",
        query: `MATCH (p:Package)-[:PACKAGE_CONTAINS_FILE]->(f:File)-[:DEFINES_FUNCTION]->(n:Function) WHERE ${packagePredicate} RETURN count(n) AS count`,
      },
      {
        table: "Class",
        query: `MATCH (p:Package)-[:PACKAGE_CONTAINS_FILE]->(f:File)-[:DEFINES_CLASS]->(n:Class) WHERE ${packagePredicate} RETURN count(n) AS count`,
      },
      {
        table: "Route",
        query: `MATCH (p:Package)-[:PACKAGE_CONTAINS_FILE]->(f:File)-[:DECLARES_ROUTE]->(n:Route) WHERE ${packagePredicate} RETURN count(n) AS count`,
      },
    ];

    const rows = [];
    for (const item of queries) {
      const result = await this.singleResult(item.query);
      rows.push({ table: item.table, count: result[0]?.count ?? 0 });
    }

    return rows;
  }

  async query(cypher: string): Promise<unknown[]> {
    const result = await this.singleResult(cypher);
    return result;
  }

  async close(): Promise<void> {
    await this.connection.close();
    await this.database.close();
  }

  private async insertNode(node: GraphNode): Promise<void> {
    const properties = { id: node.id, ...node.properties };
    await this.execute(
      `CREATE (n:${node.label} ${formatProperties(properties)})`,
    );
  }

  private async insertNodeIfMissing(node: GraphNode): Promise<boolean> {
    const rows = await this.singleResult(
      `MATCH (n) WHERE n.id = ${quote(node.id)} RETURN count(n) AS count`,
    );
    if (Number(rows[0]?.count ?? 0) > 0) {
      return false;
    }

    await this.insertNode(node);
    return true;
  }

  private async deleteFileOwnedNodes(fileId: string): Promise<void> {
    await this.execute(
      `MATCH (n) WHERE n.id = ${quote(fileId)} OR n.id STARTS WITH ${quote(`${fileId}:`)} DETACH DELETE n`,
    );
  }

  private async insertRelationship(
    relationship: GraphRelationship,
    nodeLabelById: Map<string, GraphNode["label"]>,
  ): Promise<void> {
    const relationshipType = physicalRelationshipType(relationship, nodeLabelById);
    await this.execute(
      [
        `MATCH (from {id: ${quote(relationship.from)}}), (to {id: ${quote(relationship.to)}})`,
        `CREATE (from)-[:${relationshipType} ${formatProperties(relationship.properties)}]->(to)`,
      ].join(" "),
    );
  }

  private async singleResult(statement: string): Promise<Record<string, unknown>[]> {
    const result = await withKuzuRetry(() => this.connection.query(statement), this.retry);
    const first = Array.isArray(result) ? result[0] : result;
    try {
      return (await first.getAll()) as Record<string, unknown>[];
    } finally {
      closeResults(result);
    }
  }

  private async execute(statement: string): Promise<void> {
    const result = await withKuzuRetry(() => this.connection.query(statement), this.retry);
    closeResults(result);
  }

  private async rollbackTransaction(): Promise<void> {
    try {
      await this.execute("ROLLBACK");
    } catch {
      // Preserve the original write error if rollback itself cannot complete.
    }
  }
}

function isOwnedByAffectedFile(nodeId: string, affectedFileIds: string[]): boolean {
  return affectedFileIds.some((fileId) => nodeId === fileId || nodeId.startsWith(`${fileId}:`));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
