import path from "node:path";
import { openGraphStore } from "../../composition/graph-store.js";
import { affectedTests } from "../mcp/agent-tools/affected.js";

export type AffectedAdapterOptions = {
  database: string;
  stdin?: boolean;
  json?: boolean;
  maxDepth?: number;
};

// Prints the test files that reach the changed files, one per line (or the
// whole result as JSON). `--stdin` reads more file names, one per line, for
// `git diff --name-only | concentrate affected --stdin`.
export async function runAffectedAdapter(files: string[], options: AffectedAdapterOptions): Promise<void> {
  const requested = [...files];
  if (options.stdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    requested.push(...Buffer.concat(chunks).toString("utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
  }

  const store = await openGraphStore(path.resolve(options.database));
  let result;
  try {
    result = await affectedTests(store, requested, options.maxDepth);
  } finally {
    await store.close();
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const test of result.tests) console.log(test.file);
  if (result.unmatched.length > 0) {
    console.error(`not in the graph (new, unsupported or excluded): ${result.unmatched.join(", ")}`);
  }
}
