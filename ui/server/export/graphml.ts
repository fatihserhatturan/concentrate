import { escapeXml } from "./xml.js";
import type { Selection } from "./select.js";

type GraphmlType = "string" | "long" | "double" | "boolean";

function typeOf(value: unknown): GraphmlType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "long" : "double";
  return "string";
}

// Keys get a type from all their values; a mix of types falls back to string.
function collectKeys(records: ReadonlyArray<{ properties: Record<string, unknown> }>): Map<string, GraphmlType> {
  const keys = new Map<string, GraphmlType>();
  for (const { properties } of records) {
    for (const [name, value] of Object.entries(properties)) {
      if (value === null || value === undefined) continue;
      const type = typeOf(value);
      const known = keys.get(name);
      keys.set(name, known === undefined || known === type ? type : known === "long" && type === "double" || known === "double" && type === "long" ? "double" : "string");
    }
  }
  return keys;
}

/** GraphML with typed `<data>` keys; opens in Gephi and yEd. */
export function* graphmlChunks(selection: Selection): Generator<string> {
  const nodeKeys = collectKeys(selection.nodes);
  const edgeKeys = collectKeys(selection.edges);
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n`;
  yield `  <key id="nlabel" for="node" attr.name="label" attr.type="string"/>\n`;
  for (const [name, type] of nodeKeys) yield `  <key id="n_${escapeXml(name)}" for="node" attr.name="${escapeXml(name)}" attr.type="${type}"/>\n`;
  yield `  <key id="etype" for="edge" attr.name="type" attr.type="string"/>\n`;
  for (const [name, type] of edgeKeys) yield `  <key id="e_${escapeXml(name)}" for="edge" attr.name="${escapeXml(name)}" attr.type="${type}"/>\n`;
  yield `  <graph id="G" edgedefault="directed">\n`;
  let batch = "";
  const flush = function* () { if (batch.length > 64_000) { yield batch; batch = ""; } };
  for (const node of selection.nodes) {
    batch += `    <node id="${escapeXml(node.id)}"><data key="nlabel">${escapeXml(node.label)}</data>`;
    for (const [name, value] of Object.entries(node.properties)) if (value !== null && value !== undefined) batch += `<data key="n_${escapeXml(name)}">${escapeXml(value)}</data>`;
    batch += `</node>\n`;
    yield* flush();
  }
  let id = 0;
  for (const edge of selection.edges) {
    batch += `    <edge id="e${id++}" source="${escapeXml(edge.from)}" target="${escapeXml(edge.to)}"><data key="etype">${escapeXml(edge.type)}</data>`;
    for (const [name, value] of Object.entries(edge.properties)) if (value !== null && value !== undefined) batch += `<data key="e_${escapeXml(name)}">${escapeXml(value)}</data>`;
    batch += `</edge>\n`;
    yield* flush();
  }
  if (batch) yield batch;
  yield `  </graph>\n</graphml>\n`;
}
