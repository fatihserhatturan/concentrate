import { readFile } from "node:fs/promises";
import path from "node:path";
import { coreIntegrationRegistry, findImportCycles, findUnusedExports, type ISourceReader } from "../core.js";
import { loadIndex, projectStore } from "./index.js";

export type Issues = {
  cycles: Array<{ size: number; typeOnly: boolean; files: Array<{ id: string | null; path: string }>; cycle: string[] }>;
  unused: Array<{ id: string | null; kind: string; name: string; className?: string; file: string; line: number | null; usedInFile: boolean }>;
  deadFunctions: Array<{ id: string | null; kind: string; name: string; file: string; line: number | null }>;
  /** The core's own caveat: these are candidates, not proof. */
  note: string;
};

const sourceReader: ISourceReader = { readFile: (file) => readFile(file, "utf8").catch(() => undefined) };

const cache = new Map<string, { signature: string; issues: Issues }>();

/** Import cycles and unused exports, from the core's own analysis tools (cached per graph write). */
export async function issues(projectPath: string): Promise<Issues> {
  const root = path.resolve(projectPath);
  const index = await loadIndex(root);
  const cached = cache.get(root);
  if (cached && cached.signature === index.signature) return cached.issues;

  const store = await projectStore(root);
  const [cycleResult, unusedResult] = await Promise.all([
    findImportCycles(store, { scope: "file" }),
    findUnusedExports(store, sourceReader, { rules: coreIntegrationRegistry.unusedExportRules }),
  ]);
  const result: Issues = {
    cycles: cycleResult.cycles.map((c) => ({
      size: c.size, typeOnly: c.typeOnly === true, cycle: c.cycle,
      files: [...new Set([...c.members, ...c.cycle])].map((file) => ({ id: cycleResult.ids[file] ?? null, path: file })),
    })),
    unused: unusedResult.unusedExports.map((d) => ({ id: d.id, kind: d.kind, name: d.name, ...(d.className ? { className: d.className } : {}), file: d.file, line: d.line, usedInFile: d.usedInFile })),
    deadFunctions: unusedResult.deadFunctions.map((d) => ({ id: d.id, kind: d.kind, name: d.name, file: d.file, line: d.line })),
    note: "Candidates, not proof: uses the graph cannot see (string lookups, framework conventions, consumers outside the repository) are not counted.",
  };
  cache.set(root, { signature: index.signature, issues: result });
  return result;
}
