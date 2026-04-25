import { mkdir } from "node:fs/promises";
import path from "node:path";
import kuzu from "kuzu";
import type { Connection as KuzuConnection, Database as KuzuDatabase, QueryResult as KuzuQueryResult } from "kuzu";
import { nodeLabels, relationshipTypes, schemaStatements } from "./schema.js";
import type { GraphNode, GraphRelationship } from "./model.js";

export class KuzuGraphWriter {
  private constructor(
    private readonly database: KuzuDatabase,
    private readonly connection: KuzuConnection,
  ) {}

  static async open(databasePath: string): Promise<KuzuGraphWriter> {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new kuzu.Database(databasePath) as KuzuDatabase;
    const connection = new kuzu.Connection(database) as KuzuConnection;
    return new KuzuGraphWriter(database, connection);
  }

  async reset(): Promise<void> {
    for (const type of [...relationshipTypes, "CONTAINS", "DEFINES"].reverse()) {
      await this.execute(`DROP TABLE IF EXISTS ${type}`);
    }

    for (const label of [...nodeLabels].reverse()) {
      await this.execute(`DROP TABLE IF EXISTS ${label}`);
    }

    for (const statement of schemaStatements) {
      await this.execute(statement);
    }
  }

  async write(nodes: GraphNode[], relationships: GraphRelationship[]): Promise<void> {
    for (const node of nodes) {
      await this.insertNode(node);
    }

    for (const relationship of relationships) {
      await this.insertRelationship(relationship);
    }
  }

  async stats(): Promise<Array<{ table: string; count: unknown }>> {
    const rows = [];

    for (const label of nodeLabels) {
      const result = await this.singleResult(`MATCH (n:${label}) RETURN count(n) AS count`);
      rows.push({ table: label, count: result[0]?.count ?? 0 });
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

  private async insertRelationship(relationship: GraphRelationship): Promise<void> {
    await this.execute(
      [
        `MATCH (from {id: ${quote(relationship.from)}}), (to {id: ${quote(relationship.to)}})`,
        `CREATE (from)-[:${relationship.type} ${formatProperties(relationship.properties)}]->(to)`,
      ].join(" "),
    );
  }

  private async singleResult(statement: string): Promise<Record<string, unknown>[]> {
    const result = await this.connection.query(statement);
    const first = Array.isArray(result) ? result[0] : result;
    try {
      return (await first.getAll()) as Record<string, unknown>[];
    } finally {
      closeResults(result);
    }
  }

  private async execute(statement: string): Promise<void> {
    const result = await this.connection.query(statement);
    closeResults(result);
  }
}

function closeResults(result: KuzuQueryResult | KuzuQueryResult[]): void {
  for (const item of Array.isArray(result) ? result : [result]) {
    item.close();
  }
}

function formatProperties(properties: Record<string, unknown>): string {
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return "{}";
  }

  return `{${entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join(", ")}}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return quote(String(value));
}

function quote(value: string): string {
  return JSON.stringify(value);
}
