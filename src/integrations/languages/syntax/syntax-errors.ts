import { fork, type ChildProcess } from "node:child_process";
import { withSyntaxTree, type GrammarName, type SyntaxNode } from "./tree-sitter.js";

// Lines of the first syntax errors of a source, for the warnings of non-code
// files (plain/parser.ts).
//
// V8 runs WebAssembly on its baseline compiler (Liftoff) and recompiles hot
// functions with its optimizing compiler (TurboFan). The lexers of the bash
// and powershell grammars are single functions of 160 KB and 360 KB, and
// TurboFan needs about 0.7 and 2.5 GB of memory for a few hundred ms to
// compile them: one .ps1 file raised the peak RSS of a scan by gigabytes.
// V8 flags are per process, so these grammars run in a helper process started
// with `--liftoff-only`; it starts on the first such file and ends with the
// scan's process. Their files are few and small, so baseline code is fast
// enough. If the helper cannot start or dies, the check runs here.

const BASELINE_ONLY_GRAMMARS: ReadonlySet<GrammarName> = new Set(["bash", "powershell"]);

export type SyntaxCheckRequest = { id: number; grammar: GrammarName; source: string; limit: number };
export type SyntaxCheckResponse =
  | { id: number; ok: true; lines: number[] }
  | { id: number; ok: false; message: string };

// Lines of the first syntax errors of a tree, at most `limit`.
function errorLines(root: SyntaxNode, limit: number): number[] {
  const lines = new Set<number>();
  const visit = (node: SyntaxNode) => {
    if (lines.size >= limit) return;
    if (node.isError || node.isMissing) {
      lines.add(node.startPosition.row + 1);
      return;
    }
    for (const child of node.children) {
      if (child.hasError || child.isMissing) visit(child);
    }
  };
  visit(root);
  return [...lines].sort((a, b) => a - b);
}

/** The check in this thread, whatever the grammar. */
export function syntaxErrorLinesHere(grammar: GrammarName, source: string, limit: number): Promise<number[]> {
  return withSyntaxTree(grammar, source, (tree) => (tree.rootNode.hasError ? errorLines(tree.rootNode, limit) : []));
}

/** Sorted lines of the first `limit` syntax errors of `source`; empty when it has none. */
export function syntaxErrorLines(grammar: GrammarName, source: string, limit: number): Promise<number[]> {
  if (!BASELINE_ONLY_GRAMMARS.has(grammar)) return syntaxErrorLinesHere(grammar, source, limit);
  helper ??= startHelper();
  return helper ? helper.check(grammar, source, limit) : syntaxErrorLinesHere(grammar, source, limit);
}

type Helper = { check: (grammar: GrammarName, source: string, limit: number) => Promise<number[]> };
type Job = { request: SyntaxCheckRequest; resolve: (lines: number[]) => void; reject: (error: Error) => void };

const runningFromSources = import.meta.url.endsWith(".ts");
const helperUrl = new URL(runningFromSources ? "./syntax-errors-process.ts" : "./syntax-errors-process.js", import.meta.url);
// null once the helper could not start or died: later checks run here.
let helper: Helper | null | undefined;

function startHelper(): Helper | null {
  let child: ChildProcess;
  try {
    child = fork(helperUrl, [], {
      // The process's own flags (tsx's loader when running from sources), but
      // not a debugger port the helper would compete for.
      execArgv: [...process.execArgv.filter((flag) => !flag.startsWith("--inspect")), "--liftoff-only"],
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
  } catch {
    return null;
  }

  let nextId = 0;
  let failed = false;
  const jobs = new Map<number, Job>();
  // The helper only keeps the process alive while it has checks to answer.
  const idle = () => {
    child.unref();
    child.channel?.unref();
  };
  const busy = () => {
    child.ref();
    child.channel?.ref();
  };
  const runHere = (job: Job) => syntaxErrorLinesHere(job.request.grammar, job.request.source, job.request.limit).then(job.resolve, job.reject);
  const fail = () => {
    if (failed) return;
    failed = true;
    helper = null;
    for (const job of jobs.values()) runHere(job);
    jobs.clear();
  };
  child.on("message", (response: SyntaxCheckResponse) => {
    const job = jobs.get(response.id);
    if (!job) return;
    jobs.delete(response.id);
    if (jobs.size === 0) idle();
    if (response.ok) job.resolve(response.lines);
    else job.reject(new Error(response.message));
  });
  child.on("error", fail);
  child.on("exit", fail);
  idle();

  return {
    check(grammar, source, limit) {
      return new Promise<number[]>((resolve, reject) => {
        const job: Job = { request: { id: nextId++, grammar, source, limit }, resolve, reject };
        if (failed) return runHere(job);
        jobs.set(job.request.id, job);
        busy();
        child.send(job.request, (error) => {
          if (error && jobs.delete(job.request.id)) {
            if (jobs.size === 0) idle();
            runHere(job);
          }
        });
      });
    },
  };
}
