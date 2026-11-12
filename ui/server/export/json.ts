import type { Selection } from "./select.js";

/** One JSON document: nodes, relationships, schema version, root path. Written in chunks. */
export function* jsonChunks(selection: Selection): Generator<string> {
  yield `{\n  "schemaVersion": ${JSON.stringify(selection.index.schemaVersion)},\n  "rootPath": ${JSON.stringify(selection.index.rootPath)},\n  "nodes": [`;
  yield* items(selection.nodes);
  yield `],\n  "relationships": [`;
  yield* items(selection.edges);
  yield `]\n}\n`;
}

function* items(list: ReadonlyArray<unknown>): Generator<string> {
  let batch = "";
  for (let i = 0; i < list.length; i++) {
    batch += `${i === 0 ? "\n    " : ",\n    "}${JSON.stringify(list[i])}`;
    if (batch.length > 64_000) { yield batch; batch = ""; }
  }
  if (batch) yield batch;
  if (list.length > 0) yield "\n  ";
}
