import { nodeName, type IndexNode } from "../graph/index.js";
import type { Selection } from "./select.js";

/** A DOT quoted string: backslash, quote and line breaks escaped; other characters as they are. */
export function dotString(value: unknown): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")}"`;
}

/** DOT for Graphviz: labels and types as attributes. */
export function* dotChunks(selection: Selection, header?: string): Generator<string> {
  yield `${header ? `${header.split("\n").map((l) => `// ${l}`).join("\n")}\n` : ""}digraph concentrate {\n  rankdir=LR;\n  node [shape=box, fontsize=10];\n  edge [fontsize=9];\n`;
  let batch = "";
  for (const node of selection.nodes) {
    const name = nodeName({ id: node.id, label: node.label, props: node.properties } as IndexNode);
    batch += `  ${dotString(node.id)} [label=${dotString(name)}, kind=${dotString(node.label)}];\n`;
    if (batch.length > 64_000) { yield batch; batch = ""; }
  }
  for (const edge of selection.edges) {
    batch += `  ${dotString(edge.from)} -> ${dotString(edge.to)} [label=${dotString(edge.type)}, type=${dotString(edge.type)}];\n`;
    if (batch.length > 64_000) { yield batch; batch = ""; }
  }
  yield `${batch}}\n`;
}
