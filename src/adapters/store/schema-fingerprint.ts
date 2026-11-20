import { createHash } from "node:crypto";
import type { GraphSchema } from "../../core/graph/schema.js";

const fingerprints = new WeakMap<GraphSchema, string>();

/**
 * Identifies the tables of a schema: labels, relationship types and endpoints,
 * property names and types, and their order. A snapshot stores it next to the
 * schema version, so a store opened with a different or extended schema does
 * not reuse snapshots written for another one.
 */
export function schemaFingerprint(schema: GraphSchema): string {
  let fingerprint = fingerprints.get(schema);
  if (fingerprint === undefined) {
    const description = JSON.stringify([schema.nodeTables, schema.relationshipTables, schema.nodeLabels]);
    fingerprint = createHash("sha256").update(description).digest("hex").slice(0, 32);
    fingerprints.set(schema, fingerprint);
  }
  return fingerprint;
}
