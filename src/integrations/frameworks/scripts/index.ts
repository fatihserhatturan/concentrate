import path from "node:path";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { readDockerfile } from "../../languages/plain/dockerfile.js";
import { envVar } from "../js-ts/env-files.js";
import { commandRefs, tokenize, type CommandRef } from "./commands.js";
import { addCompose, isComposeFile } from "./compose.js";
import { containerMap, resolveContainerPath, type ContainerMap } from "./container.js";
import { entrypoint, addEnv, readText, type Context, type Pending } from "./context.js";
import { scanPowerShell, scanShell, splitCommands } from "./shell.js";
import { addWorkflow, isWorkflowFile } from "./workflows.js";

// Scripts and infrastructure in the graph: what a project's `package.json`
// scripts, Makefile targets, shell and PowerShell scripts, Dockerfiles, compose
// services and GitHub Actions jobs run
// (`EntryPoint` nodes, and `RUNS` to the file or entrypoint each command
// starts) and which environment they read (`USES_ENV`) and set
// (`DECLARES_ENV`, like `.env` files do). The files are read as text: a
// command is understood for `node`, `tsx`, `go run`, `python`, a script
// path, `npm run` and `make`; anything else is not linked.

const NPM_HOOKS = ["pre", "post"];

export const scriptsContributor: ISemanticContributor = {
  async contribute(graph, rootPath, _report, files) {
    const repo = graph.nodes.find((node) => node.label === "Repo");
    if (!repo) return;

    const fileIds = new Map<string, string>();
    const languages = new Map<string, string>();
    for (const node of graph.nodes) {
      if (node.label !== "File" || typeof node.properties.relativePath !== "string") continue;
      const relative = toPosix(node.properties.relativePath);
      fileIds.set(relative, node.id);
      languages.set(relative, String(node.properties.language));
    }
    const ctx: Context = {
      graph,
      rootPath,
      repoId: repo.id,
      fileIds,
      npmScripts: new Map(),
      makeTargets: new Map(),
      scriptEntries: new Map(),
      dockerfiles: new Map(),
      pending: [],
    };

    for (const file of [...files].sort()) {
      const relative = toPosix(path.relative(rootPath, file));
      const fileId = fileIds.get(relative);
      if (!fileId) continue;
      const language = languages.get(relative);
      const name = path.posix.basename(relative);
      let text: string | null = null;
      if (name === "package.json") text = await readText(file);
      else if (language === "makefile" || language === "dockerfile" || language === "shell" || language === "powershell") text = await readText(file);
      else if (language === "yaml" && (isComposeFile(relative) || isWorkflowFile(relative))) text = await readText(file);
      if (text === null) continue;
      if (name === "package.json") addNpmScripts(ctx, relative, fileId, text);
      else if (language === "makefile") addMakefile(ctx, relative, fileId, text);
      else if (language === "dockerfile") addDockerfile(ctx, relative, fileId, text);
      else if (language === "yaml" && isWorkflowFile(relative)) await addWorkflow(ctx, relative, fileId, text);
      else if (language === "yaml") await addCompose(ctx, relative, fileId, text);
      else if (language === "shell" || (language === "powershell" && name.toLowerCase().endsWith(".ps1"))) addScript(ctx, relative, fileId, text, language);
    }

    resolveRuns(ctx);
  },
};

// ---- package.json scripts

function addNpmScripts(ctx: Context, relative: string, fileId: string, text: string): void {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
  } catch {
    return;
  }
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return;
  const directory = path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
  const lines = text.split(/\r?\n/u);
  const scriptsLine = Math.max(0, lines.findIndex((line) => /"scripts"\s*:/u.test(line)));
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== "string") continue;
    const index = lines.findIndex((line, at) => at >= scriptsLine && line.includes(`${JSON.stringify(name)}`));
    const line = index === -1 ? 1 : index + 1;
    const id = entrypoint(ctx, fileId, `entrypoint:npm-script:${relative}:${name}`, { kind: "npm-script", trigger: name, library: "npm", line, handlerName: command.slice(0, 300) });
    ctx.npmScripts.set(`${directory}\0${name}`, id);
    ctx.pending.push({ from: id, cwds: [directory], commands: splitCommands(command).map((text) => ({ text, line })) });
    addEnv(ctx, id, relative, scanShell(command), line - 1);
  }
  // `prebuild` and `postbuild` run around `build` without being named.
  for (const [name] of Object.entries(scripts as Record<string, unknown>)) {
    for (const hook of NPM_HOOKS) {
      const base = name.startsWith(hook) ? name.slice(hook.length) : null;
      const hookId = ctx.npmScripts.get(`${directory}\0${name}`);
      const baseId = base ? ctx.npmScripts.get(`${directory}\0${base}`) : undefined;
      if (!hookId || !baseId) continue;
      ctx.graph.addRelationship({ from: baseId, to: hookId, type: "RUNS", properties: { line: 0, command: `${hook} hook` } });
    }
  }
}

// ---- Makefile

function addMakefile(ctx: Context, relative: string, fileId: string, text: string): void {
  const directory = path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
  const raw = text.split(/\r?\n/u);
  type Rule = { id: string; recipe: Array<{ text: string; line: number }>; deps: string[]; line: number };
  const rules = new Map<string, Rule>();
  let current: Rule[] = [];
  const declarations: Array<{ name: string; line: number }> = [];

  for (let index = 0; index < raw.length; index += 1) {
    let line = raw[index]!;
    const start = index + 1;
    while (line.endsWith("\\") && index + 1 < raw.length) {
      line = `${line.slice(0, -1)} ${raw[++index]!.trim()}`;
    }
    if (line.startsWith("\t")) {
      const recipe = line.replace(/^\t+[@\-+]*/u, "").replace(/\$\$/gu, "$").trim();
      if (recipe !== "") for (const rule of current) rule.recipe.push({ text: recipe, line: start });
      continue;
    }
    const exported = /^export\s+([A-Za-z_]\w*)(?:\s*(?:[:?+]?=).*)?$/u.exec(line.trim());
    if (exported) {
      declarations.push({ name: exported[1]!, line: start });
      current = [];
      continue;
    }
    const rule = /^([^\s:=#][^:=#]*?)\s*::?(?!=)\s*([^=]*?)(?:\s*;\s*(.*))?$/u.exec(line);
    if (!rule || /[$%]/u.test(rule[1]!) || line.trimStart().startsWith("#")) {
      current = [];
      continue;
    }
    const targets = rule[1]!.split(/\s+/u).filter((target) => !target.startsWith(".") && !/[/$%]/u.test(target));
    const deps = (rule[2] ?? "").split("|")[0]!.split(/\s+/u).filter((dep) => dep !== "" && !/[$%/]/u.test(dep) && !dep.startsWith("."));
    current = [];
    for (const target of targets) {
      let entry = rules.get(target);
      if (!entry) {
        const id = entrypoint(ctx, fileId, `entrypoint:make:${relative}:${target}`, { kind: "make", trigger: target, library: "make", line: start, handlerName: null });
        entry = { id, recipe: [], deps: [], line: start };
        rules.set(target, entry);
        ctx.makeTargets.set(`${directory}\0${target}`, id);
      }
      entry.deps.push(...deps);
      if (rule[3]) entry.recipe.push({ text: rule[3].trim(), line: start });
      current.push(entry);
    }
  }

  for (const rule of rules.values()) {
    for (const dep of rule.deps) {
      const to = rules.get(dep)?.id;
      if (to && to !== rule.id) ctx.graph.addRelationship({ from: rule.id, to, type: "RUNS", properties: { line: rule.line, command: `dependency ${dep}` } });
    }
    const commands = rule.recipe.flatMap((entry) => splitCommands(entry.text).map((command) => ({ text: command, line: entry.line })));
    ctx.pending.push({ from: rule.id, cwds: [directory], commands });
    const scan = scanShell(rule.recipe.map((entry) => entry.text).join("\n"));
    // Line numbers inside the joined recipe map back to the recipe lines.
    for (const read of scan.reads) {
      ctx.graph.addRelationship({ from: rule.id, to: envVar(ctx.graph, read.name), type: "USES_ENV", properties: { line: rule.recipe[read.line - 1]?.line ?? rule.line, access: read.access } });
    }
    for (const declaration of scan.declarations) {
      ctx.graph.addRelationship({ from: ctx.repoId, to: envVar(ctx.graph, declaration.name), type: "DECLARES_ENV", properties: { file: relative, line: rule.recipe[declaration.line - 1]?.line ?? rule.line } });
    }
  }
  for (const declaration of declarations) {
    ctx.graph.addRelationship({ from: ctx.repoId, to: envVar(ctx.graph, declaration.name), type: "DECLARES_ENV", properties: { file: relative, line: declaration.line } });
  }
}

// ---- shell and PowerShell scripts

function addScript(ctx: Context, relative: string, fileId: string, text: string, language: string): void {
  const id = entrypoint(ctx, fileId, `entrypoint:script:${relative}`, { kind: "script", trigger: relative, library: language, line: 1, handlerName: null });
  ctx.scriptEntries.set(relative, id);
  const scan = language === "powershell" ? scanPowerShell(text) : scanShell(text);
  const directory = path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
  ctx.pending.push({ from: id, cwds: directory === "" ? [""] : ["", directory], commands: scan.commands });
  addEnv(ctx, id, relative, scan);
}

// ---- Dockerfile

function addDockerfile(ctx: Context, relative: string, fileId: string, text: string): void {
  const directory = path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
  const { instructions } = readDockerfile(text);
  ctx.dockerfiles.set(relative, instructions);
  for (const { instruction, args, line } of instructions) {
    let owner = fileId;
    if (instruction === "CMD" || instruction === "ENTRYPOINT") {
      const command = dockerCommand(args);
      owner = entrypoint(ctx, fileId, `entrypoint:docker:${relative}:${line}`, { kind: "docker", trigger: instruction, library: "docker", line, handlerName: command.slice(0, 300) });
      ctx.pending.push({ from: owner, cwds: directory === "" ? [""] : [directory, ""], commands: splitCommands(command).map((part) => ({ text: part, line })), image: { dockerfile: relative, context: directory } });
    }
    if (instruction === "ENV" || instruction === "ARG") {
      for (const name of dockerDeclared(instruction, args)) {
        ctx.graph.addRelationship({ from: ctx.repoId, to: envVar(ctx.graph, name), type: "DECLARES_ENV", properties: { file: relative, line } });
      }
    }
    if (["RUN", "CMD", "ENTRYPOINT", "COPY", "ADD", "WORKDIR", "USER", "FROM", "EXPOSE", "LABEL", "VOLUME", "ENV", "ARG", "HEALTHCHECK", "SHELL", "STOPSIGNAL"].includes(instruction)) {
      const scan = scanShell(instruction === "ENV" || instruction === "ARG" ? args.replace(/^[^=\s]+=?/u, "") : dockerCommand(args));
      for (const read of scan.reads) {
        ctx.graph.addRelationship({ from: owner, to: envVar(ctx.graph, read.name), type: "USES_ENV", properties: { line, access: read.access } });
      }
      // `RUN FOO=bar make` sets FOO for that command.
      if (instruction === "RUN") {
        for (const declaration of scan.declarations) {
          ctx.graph.addRelationship({ from: ctx.repoId, to: envVar(ctx.graph, declaration.name), type: "DECLARES_ENV", properties: { file: relative, line } });
        }
      }
    }
  }
}

// `["node", "dist/main.js"]` (exec form) or a shell command.
function dockerCommand(args: string): string {
  if (args.startsWith("[")) {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) return (parsed as string[]).join(" ");
    } catch {
      // Not exec form.
    }
  }
  return args;
}

// `ENV A=1 B="x y"`, `ENV A 1`, `ARG A=1`, `ARG A`.
function dockerDeclared(instruction: string, args: string): string[] {
  if (instruction === "ARG") {
    const name = /^([A-Za-z_]\w*)/u.exec(args)?.[1];
    return name ? [name] : [];
  }
  const tokens = tokenize(args);
  if (tokens.length >= 2 && !tokens[0]!.includes("=")) return /^[A-Za-z_]\w*$/u.test(tokens[0]!) ? [tokens[0]!] : [];
  return tokens.flatMap((token) => {
    const name = /^([A-Za-z_]\w*)=/u.exec(token)?.[1];
    return name ? [name] : [];
  });
}

// ---- RUNS

function resolveRuns(ctx: Context): void {
  const goMainFiles = new Map<string, string[]>();
  const functionNames = new Map<string, string>();
  for (const node of ctx.graph.nodes) {
    if (node.label === "Function" && node.properties.name === "main") functionNames.set(node.id, node.id);
  }
  if (functionNames.size > 0) {
    const relativeById = new Map([...ctx.fileIds].map(([relative, id]) => [id, relative]));
    for (const rel of ctx.graph.relationships) {
      if (rel.type !== "DEFINES_FUNCTION" || !functionNames.has(rel.to)) continue;
      const relative = relativeById.get(rel.from);
      if (!relative?.endsWith(".go")) continue;
      const directory = path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
      goMainFiles.set(directory, [...goMainFiles.get(directory) ?? [], rel.from]);
    }
  }

  const seen = new Set<string>();
  const link = (from: string, to: string, line: number, command: string) => {
    const key = `${from}\0${to}`;
    if (seen.has(key) || from === to) return;
    seen.add(key);
    ctx.graph.addRelationship({ from, to, type: "RUNS", properties: { line, command: command.slice(0, 200) } });
  };

  // A path inside the container (`/app/start.sh`), through the Dockerfile's COPY and WORKDIR.
  const containerMaps = new Map<string, ContainerMap>();
  const exists = (relative: string) => ctx.fileIds.has(relative);
  const containerFile = (image: Pending["image"], containerPath: string): string | null => {
    const instructions = image ? ctx.dockerfiles.get(image.dockerfile) : undefined;
    if (!image || !instructions) return null;
    const key = `${image.dockerfile}\0${image.context}`;
    let map = containerMaps.get(key);
    if (!map) containerMaps.set(key, map = containerMap(instructions, image.context, exists));
    return resolveContainerPath(map, containerPath, exists);
  };

  for (const pending of ctx.pending) {
    for (const command of pending.commands) {
      // `cd dir && …` on the same line changes where the next commands look.
      const tokens = tokenize(command.text);
      if (tokens[0] === "cd" && tokens[1] && !/[$`]/u.test(tokens[1])) {
        pending.cwds = pending.cwds.map((cwd) => path.posix.join(cwd, tokens[1]!));
        continue;
      }
      for (const ref of commandRefs(command.text)) {
        const inContainer = ref.kind === "file" && ref.path.startsWith("/") && !/[$`]/u.test(ref.path) ? containerFile(pending.image, ref.path) : null;
        const targets = inContainer !== null ? [ctx.scriptEntries.get(inContainer) ?? ctx.fileIds.get(inContainer)!] : resolveRef(ref, pending.cwds, ctx, goMainFiles);
        for (const to of targets) link(pending.from, to, command.line, command.text);
      }
    }
  }
}

function resolveRef(ref: CommandRef, cwds: string[], ctx: Context, goMainFiles: Map<string, string[]>): string[] {
  const join = (cwd: string, target: string) => path.posix.normalize(path.posix.join(cwd, target.replace(/^\.\//u, "")));
  const file = (candidates: string[]): string[] => {
    for (const candidate of candidates) {
      if (candidate.startsWith("../") || path.posix.isAbsolute(candidate)) continue;
      const id = ctx.fileIds.get(candidate);
      if (id) return [ctx.scriptEntries.get(candidate) ?? id];
    }
    return [];
  };
  switch (ref.kind) {
    case "file":
      if (/[$`]/u.test(ref.path) || ref.path.startsWith("/")) return [];
      return file([...cwds.map((cwd) => join(cwd, ref.path)), path.posix.normalize(ref.path.replace(/^\.\//u, ""))]);
    case "go": {
      if (/[$`]|\.\.\./u.test(ref.path)) return [];
      for (const candidate of [...cwds.map((cwd) => join(cwd, ref.path)), path.posix.normalize(ref.path.replace(/^\.\//u, ""))]) {
        if (ref.path.endsWith(".go")) {
          const found = file([candidate]);
          if (found.length > 0) return found;
        } else {
          const directory = candidate === "." ? "" : candidate;
          const files = goMainFiles.get(directory);
          if (files) return files;
        }
      }
      return [];
    }
    case "python-module": {
      const base = ref.module.split(".").join("/");
      return file(cwds.flatMap((cwd) => [join(cwd, `${base}.py`), join(cwd, `${base}/__main__.py`), join(cwd, `src/${base}.py`), join(cwd, `src/${base}/__main__.py`)]));
    }
    case "npm": {
      const start = ref.dir ? cwds.map((cwd) => join(cwd, ref.dir!)) : cwds;
      const seenDirs = new Set<string>();
      for (const origin of start) {
        // The package of the caller, then its ancestors (workspace roots).
        for (let directory = origin; ; directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "") {
          if (!seenDirs.has(directory)) {
            seenDirs.add(directory);
            const id = ctx.npmScripts.get(`${directory === "." ? "" : directory}\0${ref.script}`);
            if (id) return [id];
          }
          if (directory === "" || directory === ".") break;
        }
      }
      return [];
    }
    case "make": {
      const dirs = ref.dir ? cwds.map((cwd) => join(cwd, ref.dir!)) : cwds;
      for (const directory of dirs) {
        const id = ctx.makeTargets.get(`${directory === "." ? "" : directory}\0${ref.target}`);
        if (id) return [id];
      }
      return [];
    }
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
