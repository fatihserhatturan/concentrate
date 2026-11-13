// Which folder cluster a file belongs to, shared by the graph screen's data and the HTML export.

/** Folder of a file cut to `depth` segments; a file in the root belongs to "(root)". */
export function groupAt(relativePath: string, depth: number): string {
  const segments = relativePath.split("/").slice(0, -1);
  return segments.length === 0 ? "(root)" : segments.slice(0, depth).join("/");
}

/**
 * Cluster of each file (null stays "(other)": routes, tables, env vars… that no file owns).
 * The folders are cut deep enough to tell at least six clusters apart, at most three levels.
 */
export function clusterOf(files: ReadonlyArray<string | null>): string[] {
  const known = files.filter((f): f is string => f !== null && f !== "");
  let depth = 1;
  while (depth < 3 && new Set(known.map((f) => groupAt(f, depth))).size < 6) depth += 1;
  return files.map((f) => (f ? groupAt(f, depth) : "(other)"));
}
