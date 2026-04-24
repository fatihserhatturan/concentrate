import path from "node:path";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";

type QueryOptions = {
  database: string;
};

export async function queryCommand(cypher: string, options: QueryOptions): Promise<void> {
  const writer = await KuzuGraphWriter.open(path.resolve(options.database));
  const rows = await writer.query(cypher);
  await writer.close();

  console.dir(rows, { depth: null });
}
