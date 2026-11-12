import path from "node:path";
import { openGraphStore } from "../core.js";
import { graphPath, loadIndex } from "../graph/index.js";

export const MAX_QUERY_ROWS = 1000;

/** Runs a read-only Cypher query; the engine refuses writes ("Unsupported Cypher feature"). */
export async function runQuery(projectPath: string, cypher: unknown): Promise<{ columns: string[]; rows: unknown[]; total: number; truncated: boolean }> {
  if (typeof cypher !== "string" || cypher.trim().length === 0) throw new Error("`query` is required");
  await loadIndex(projectPath); // a clear error when there is no graph
  const store = await openGraphStore(graphPath(path.resolve(projectPath)), { retryLock: false });
  try {
    const all = (await store.query(cypher)) as Array<Record<string, unknown>>;
    return {
      columns: all.length > 0 ? Object.keys(all[0]!) : [],
      rows: all.slice(0, MAX_QUERY_ROWS),
      total: all.length,
      truncated: all.length > MAX_QUERY_ROWS,
    };
  } finally {
    await store.close();
  }
}
