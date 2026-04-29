import type { QueryResult as KuzuQueryResult } from "kuzu";

export function closeResults(result: KuzuQueryResult | KuzuQueryResult[]): void {
  for (const item of Array.isArray(result) ? result : [result]) {
    item.close();
  }
}
