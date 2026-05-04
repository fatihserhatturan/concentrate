import { formatProperties } from "./kuzu-format.js";
import {
  nodeLabels,
  relationshipTypes,
  schemaStatements,
  schemaVersionTableStatement,
  SCHEMA_VERSION,
} from "./schema.js";

export async function resetKuzuSchema(execute: (statement: string) => Promise<void>): Promise<void> {
  await execute("DROP TABLE IF EXISTS _SchemaVersion");

  for (const type of [...relationshipTypes, "CONTAINS", "DEFINES"].reverse()) {
    await execute(`DROP TABLE IF EXISTS ${type}`);
  }

  for (const label of [...nodeLabels].reverse()) {
    await execute(`DROP TABLE IF EXISTS ${label}`);
  }

  for (const statement of schemaStatements) {
    await execute(statement);
  }

  await execute(schemaVersionTableStatement);
  await execute(
    `CREATE (:_SchemaVersion ${formatProperties({ version: SCHEMA_VERSION, writtenAt: new Date().toISOString() })})`,
  );
}

export async function readKuzuSchemaVersion(
  singleResult: (statement: string) => Promise<Record<string, unknown>[]>,
): Promise<number | null> {
  try {
    const rows = await singleResult("MATCH (v:_SchemaVersion) RETURN v.version AS version LIMIT 1");
    const version = rows[0]?.version;
    return typeof version === "number" ? version : null;
  } catch {
    return null;
  }
}
