import path from "node:path";
import { defaultKuzuRetryOptions } from "../../graph/kuzu-retry.js";
import { KuzuGraphWriter } from "../kuzu/index.js";

export type OutputFormat = "json" | "table" | "csv";

export type QueryAdapterOptions = {
  database: string;
  format: OutputFormat;
  retryLock: boolean;
};

export async function runQueryAdapter(cypher: string, options: QueryAdapterOptions): Promise<void> {
  const writer = await KuzuGraphWriter.open(path.resolve(options.database), {
    retry: options.retryLock !== false ? defaultKuzuRetryOptions : false,
  });
  let rows: unknown[];
  try {
    rows = await writer.query(cypher);
  } finally {
    await writer.close();
  }

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
