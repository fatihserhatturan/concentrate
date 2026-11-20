import { writeFile } from "node:fs/promises";
import { formatJsonl } from "../core/graph/jsonl.js";
import type { GraphNode, GraphRelationship } from "../core/graph/model.js";

export async function writeJsonl(
  filePath: string,
  records: ReadonlyArray<GraphNode | GraphRelationship>,
): Promise<void> {
  await writeFile(filePath, formatJsonl(records), "utf8");
}
