import { runQueryAdapter, type QueryAdapterOptions } from "../adapters/cli/index.js";

type QueryOptions = QueryAdapterOptions;

export async function queryCommand(cypher: string, options: QueryOptions): Promise<void> {
  await runQueryAdapter(cypher, options);
}
