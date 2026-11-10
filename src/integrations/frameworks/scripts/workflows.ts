import path from "node:path";
import { envVar } from "../js-ts/env-files.js";
import { entrypoint, type Context } from "./context.js";
import { scanShell } from "./shell.js";
import { asMap, asSeq, asText, mapGet, readYaml, scalars, type YMap, type YValue } from "./yaml.js";

// GitHub Actions workflows (`.github/workflows/*.yml`): each job is an
// `EntryPoint` (kind `ci-job`). A step's `run:` runs what its commands name
// (`RUNS`), `env:` at the workflow, job or step level declares env (like
// `.env` files do), and `${{ env.X }}`, `${{ secrets.X }}`, `${{ vars.X }}`
// and `$X` in a `run:` read it.

export function isWorkflowFile(relative: string): boolean {
  return /^(?:.*\/)?\.github\/workflows\/[^/]+\.ya?ml$/u.test(relative);
}

// Set by the runner, not by the project.
const PROVIDED = /^(?:GITHUB_|RUNNER_|ACTIONS_|CI$)/u;

// `env.X`, `secrets.X` and `vars.X` inside `${{ … }}` (and in an `if:`).
function expressionNames(text: string, wholeText: boolean): string[] {
  const sources = wholeText ? [text] : [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)].map((match) => match[1]!);
  return sources.flatMap((source) => [...source.matchAll(/\b(?:env|secrets|vars)\.([A-Za-z_]\w*)/gu)].map((match) => match[1]!));
}

export async function addWorkflow(ctx: Context, relative: string, fileId: string, text: string): Promise<void> {
  const doc = asMap(await readYaml(text));
  const jobs = asMap(mapGet(doc, "jobs")?.value);
  if (!doc || !jobs) return;
  const workflowName = asText(mapGet(doc, "name")?.value);
  const declare = (name: string, line: number) => ctx.graph.addRelationship({ from: ctx.repoId, to: envVar(ctx.graph, name), type: "DECLARES_ENV", properties: { file: relative, line } });
  const read = (owner: string, name: string, line: number, access: string) => ctx.graph.addRelationship({ from: owner, to: envVar(ctx.graph, name), type: "USES_ENV", properties: { line, access } });
  const declareAll = (value: YValue | undefined) => {
    for (const entry of asMap(value)?.entries ?? []) declare(entry.key, entry.line);
  };
  const defaultDirectory = (map: YMap | null): string | null => asText(mapGet(asMap(mapGet(asMap(mapGet(map, "defaults")?.value), "run")?.value), "working-directory")?.value);

  declareAll(mapGet(doc, "env")?.value);
  const workflowDirectory = defaultDirectory(doc);
  // Expressions outside the jobs read from the file.
  for (const entry of doc.entries.filter((candidate) => candidate.key !== "jobs")) {
    for (const scalar of scalars(entry.value)) for (const name of expressionNames(scalar.text, false)) read(fileId, name, scalar.line, `\${{ ${name} }}`);
  }

  for (const job of jobs.entries) {
    const body = asMap(job.value);
    if (!body) continue;
    const id = entrypoint(ctx, fileId, `entrypoint:ci-job:${relative}:${job.key}`, {
      kind: "ci-job",
      trigger: job.key,
      library: "github-actions",
      line: job.line,
      handlerName: (asText(mapGet(body, "name")?.value) ?? workflowName)?.slice(0, 300) ?? null,
    });
    declareAll(mapGet(body, "env")?.value);

    // `uses: ./.github/workflows/build.yml`: a reusable workflow of the project.
    const reusable = asText(mapGet(body, "uses")?.value);
    if (reusable?.startsWith("./")) {
      const target = ctx.fileIds.get(path.posix.normalize(reusable));
      if (target) ctx.graph.addRelationship({ from: id, to: target, type: "RUNS", properties: { line: job.line, command: `uses ${reusable}`.slice(0, 200) } });
    }

    // `${{ env.X }}` and friends anywhere in the job.
    const seen = new Set<string>();
    const walk = (value: YValue, key: string | null) => {
      for (const scalar of scalars(value)) {
        for (const name of expressionNames(scalar.text, key === "if")) {
          const mark = `${name}:${scalar.line}`;
          if (seen.has(mark)) continue;
          seen.add(mark);
          read(id, name, scalar.line, `\${{ ${name} }}`);
        }
      }
    };
    for (const entry of body.entries) walk(entry.value, entry.key);
    for (const step of asSeq(mapGet(body, "steps")?.value)?.items ?? []) {
      const stepMap = asMap(step.value);
      if (!stepMap) continue;
      declareAll(mapGet(stepMap, "env")?.value);
      for (const entry of stepMap.entries) if (entry.key === "if") walk(entry.value, "if");
    }

    const jobDirectory = defaultDirectory(body) ?? workflowDirectory;
    for (const step of asSeq(mapGet(body, "steps")?.value)?.items ?? []) {
      const stepMap = asMap(step.value);
      const run = mapGet(stepMap, "run");
      const script = asText(run?.value);
      if (!stepMap || !run || script === null) continue;
      // `${{ … }}` is filled in before the shell runs: it is not shell syntax.
      const shell = scanShell(script.replace(/\$\{\{[\s\S]*?\}\}/gu, "__EXPR__"));
      // A block scalar's text starts on the line after its header.
      const first = run.value?.type === "scalar" && script.includes("\n") ? run.line : run.line - 1;
      for (const entry of shell.reads) if (!PROVIDED.test(entry.name)) read(id, entry.name, first + entry.line, entry.access);
      for (const entry of shell.declarations) declare(entry.name, first + entry.line);
      const directory = asText(mapGet(stepMap, "working-directory")?.value) ?? jobDirectory ?? "";
      const cwd = path.posix.normalize(directory).replace(/^\.$/u, "");
      ctx.pending.push({ from: id, cwds: cwd === "" ? [""] : [cwd, ""], commands: shell.commands.map((command) => ({ text: command.text, line: first + command.line })) });
    }
  }
}
