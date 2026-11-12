import path from "node:path";
import { nudgeOutput } from "./init-steering.js";

export type NudgeAdapterOptions = { database: string };

// The hook must never fail a tool call: any problem prints nothing and exits 0.
export async function runNudgeAdapter(options: NudgeAdapterOptions): Promise<void> {
  let input: unknown = null;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // No or malformed input: nudge without a session id.
  }
  try {
    const output = nudgeOutput(input, { databasePath: path.resolve(options.database) });
    if (output) process.stdout.write(`${output}\n`);
  } catch {
    // Advisory only.
  }
}
