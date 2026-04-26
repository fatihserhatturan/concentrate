import path from "node:path";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";

type OutputFormat = "json" | "table" | "csv";

type QueryOptions = {
  database: string;
  format: OutputFormat;
};

export async function queryCommand(cypher: string, options: QueryOptions): Promise<void> {
  const writer = await KuzuGraphWriter.open(path.resolve(options.database));
  const rows = await writer.query(cypher);
  await writer.close();

  printRows(rows, options.format);
}

function printRows(rows: unknown[], format: OutputFormat): void {
  if (format === "table") {
    console.table(rows);
    return;
  }

  if (format === "csv") {
    if (rows.length === 0) return;
    const headers = Object.keys(rows[0] as Record<string, unknown>);
    console.log(headers.map(csvEscape).join(","));
    for (const row of rows) {
      console.log(headers.map((h) => csvEscape((row as Record<string, unknown>)[h])).join(","));
    }
    return;
  }

  console.log(JSON.stringify(rows, null, 2));
}

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
