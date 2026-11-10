import type { IQueryEngine } from "../../../core/contracts/query-engine.js";

// The scripts, Makefile targets, npm scripts, Dockerfile commands, compose
// services and CI jobs that start a file, directly (`RUNS` to the file, or to
// an entrypoint the file declares) or through another one that runs them.

export type Runner = {
  kind: string;
  trigger: string;
  file: string;
  line: number | null;
  // 1 = starts the file itself; 2 = starts a runner of depth 1, and so on.
  depth: number;
  // What it runs: the command text (`go run ./cmd/server`) or `dependency x`.
  command: string | null;
  // The file or entrypoint it reaches at depth 1.
  runs: string;
};

type Row = Record<string, unknown>;

export async function loadRunners(
  engine: IQueryEngine,
  // Whether a scan-relative path is one of the files asked about.
  matches: (relativePath: string) => boolean,
  maxDepth: number,
): Promise<Runner[]> {
  const [entries, entryRuns, fileRuns] = await Promise.all([
    engine.query(`
      MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entry:EntryPoint)
      RETURN id(entry) AS id, file.relativePath AS file, entry.kind AS kind, entry.trigger AS trigger, entry.line AS line
    `) as Promise<Row[]>,
    engine.query(`
      MATCH (runner:EntryPoint)-[run:RUNS_ENTRYPOINT]->(target:EntryPoint)
      RETURN id(runner) AS runner, id(target) AS target, run.command AS command
    `) as Promise<Row[]>,
    engine.query(`
      MATCH (runner:EntryPoint)-[run:RUNS_FILE]->(target:File)
      RETURN id(runner) AS runner, target.relativePath AS file, run.command AS command
    `) as Promise<Row[]>,
  ]);
  if (entryRuns.length === 0 && fileRuns.length === 0) return [];

  const info = new Map(entries.map((row) => [String(row.id), row]));
  const found = new Map<string, Runner>();
  const record = (id: string, depth: number, command: unknown, runs: string) => {
    const entry = info.get(id);
    if (!entry || found.has(id)) return false;
    found.set(id, {
      kind: String(entry.kind),
      trigger: String(entry.trigger),
      file: String(entry.file),
      line: typeof entry.line === "number" ? entry.line : null,
      depth,
      command: typeof command === "string" ? command : null,
      runs,
    });
    return true;
  };

  // Entrypoints the asked-about files declare (a script's own, a Makefile's
  // targets): runners of those run the file too.
  const asked = new Map<string, string>();
  for (const row of entries) if (matches(String(row.file))) asked.set(String(row.id), String(row.file));

  let frontier: string[] = [];
  for (const row of fileRuns) {
    const file = String(row.file);
    if (matches(file) && record(String(row.runner), 1, row.command, file)) frontier.push(String(row.runner));
  }
  for (const row of entryRuns) {
    const file = asked.get(String(row.target));
    if (file !== undefined && record(String(row.runner), 1, row.command, file)) frontier.push(String(row.runner));
  }

  // Whoever runs a file that declares entrypoints (a compose service building
  // a Dockerfile, a job using a reusable workflow) runs those entrypoints.
  const filesRunBy = new Map<string, Row[]>();
  for (const row of fileRuns) filesRunBy.set(String(row.file), [...filesRunBy.get(String(row.file)) ?? [], row]);

  for (let depth = 2; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const reached = new Set(frontier);
    const next: string[] = [];
    for (const row of entryRuns) {
      if (!reached.has(String(row.target))) continue;
      const via = info.get(String(row.target));
      if (record(String(row.runner), depth, row.command, via ? `${String(via.kind)}:${String(via.trigger)}` : "")) next.push(String(row.runner));
    }
    for (const id of frontier) {
      const via = info.get(id);
      for (const row of via ? filesRunBy.get(String(via.file)) ?? [] : []) {
        if (record(String(row.runner), depth, row.command, `${String(via!.kind)}:${String(via!.trigger)}`)) next.push(String(row.runner));
      }
    }
    frontier = next;
  }
  return [...found.values()].sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.trigger.localeCompare(b.trigger));
}
