import { writeFile } from "node:fs/promises";
import type { GraphNode, GraphRelationship } from "../../core/graph/model.js";

/** One JSON record per line, with a trailing newline; an empty list writes an empty file. */
export function formatJsonl(records: ReadonlyArray<GraphNode | GraphRelationship>): string {
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  return content.length > 0 ? `${content}\n` : "";
}

export async function writeJsonl(
  filePath: string,
  records: ReadonlyArray<GraphNode | GraphRelationship>,
): Promise<void> {
  await writeFile(filePath, formatJsonl(records), "utf8");
}
