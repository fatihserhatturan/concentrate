import path from "node:path";
import { findImportCycles, findUnusedExports, openGraphStore, type PageWindow } from "../core.js";
import { graphPath, loadIndex, type GraphIndex } from "./index.js";

export type Issues = {
  cycles: Array<{ size: number; typeOnly: boolean; files: Array<{ id: string | null; path: string }>; cycle: string[] }>;
  unused: Array<{ id: string | null; kind: string; name: string; className?: string; file: string; line: number | null; usedInFile: boolean }>;
  deadFunctions: Array<{ id: string | null; kind: string; name: string; file: string; line: number | null }>;
  /** The core's own caveat: these are candidates, not proof. */
  note: string;
};

// The core's tools page their lists; here the whole list is wanted.
const everything: PageWindow = { offset: 0, limit: Number.MAX_SAFE_INTEGER, fetch: Number.MAX_SAFE_INTEGER, take: (rows) => rows.slice() };

const cache = new Map<string, { signature: string; issues: Issues }>();

type Declaration = { kind: string; name: string; className?: string; file: string; line: number | null; usedInFile?: boolean };

function nodeIds(index: GraphIndex) {
  const byFile = new Map<string, string>();
  const declarations = new Map<string, string>();
  for (const node of index.nodes.values()) {
    if (node.label === "File") byFile.set(String(node.props.relativePath ?? ""), node.id);
  }
  for (const [file, owner] of index.fileOf) {
    if (file === owner) continue;
    const node = index.nodes.get(file)!;
    const relative = String(index.nodes.get(owner)?.props.relativePath ?? "");
    declarations.set(`${relative}\0${String(node.props.name ?? "")}\0${node.props.line ?? ""}`, node.id);
  }
  return { file: (rel: string) => byFile.get(rel) ?? null, declaration: (d: Declaration) => declarations.get(`${d.file}\0${d.name}\0${d.line ?? ""}`) ?? null };
}

/** Import cycles and unused exports, from the core's own analysis tools (cached per graph write). */
export async function issues(projectPath: string): Promise<Issues> {
  const root = path.resolve(projectPath);
  const index = await loadIndex(root);
  const cached = cache.get(root);
  if (cached && cached.signature === index.signature) return cached.issues;

  const store = await openGraphStore(graphPath(root), { retryLock: false });
  let cycleResult: any;
  let unusedResult: any;
  try {
    cycleResult = await findImportCycles(store, { scope: "file" }, everything);
    unusedResult = await findUnusedExports(store, {}, everything);
  } finally {
    await store.close();
  }
  const ids = nodeIds(index);
  const result: Issues = {
    cycles: (cycleResult.cycles as Array<{ size: number; members: string[]; cycle: string[]; typeOnly?: boolean }>).map((c) => ({
      size: c.size, typeOnly: c.typeOnly === true, cycle: c.cycle,
      files: [...new Set([...c.members, ...c.cycle])].map((file) => ({ id: ids.file(file), path: file })),
    })),
    unused: (unusedResult.unusedExports as Declaration[]).map((d) => ({ id: ids.declaration(d), kind: d.kind, name: d.name, ...(d.className ? { className: d.className } : {}), file: d.file, line: d.line, usedInFile: d.usedInFile === true })),
    deadFunctions: (unusedResult.deadFunctions as Declaration[]).map((d) => ({ id: ids.declaration(d), kind: d.kind, name: d.name, file: d.file, line: d.line })),
    note: "Candidates, not proof: uses the graph cannot see (string lookups, framework conventions, consumers outside the repository) are not counted.",
  };
  cache.set(root, { signature: index.signature, issues: result });
  return result;
}
