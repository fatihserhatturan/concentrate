import path from "node:path";
import { envVar, isEnvFile, parseEnvFile } from "../js-ts/env-files.js";
import { entrypoint, readText, type Context } from "./context.js";
import { isEnvName, splitCommands } from "./shell.js";
import { asMap, asSeq, asText, mapGet, readYaml, scalars, type YValue } from "./yaml.js";

// Compose files: each service is an `EntryPoint` (kind `compose-service`).
// `build:` runs the service's Dockerfile (`RUNS` to the file), `command:` and
// `entrypoint:` run what they name, `environment:` and `env_file:` declare
// env (like `.env` files do) and `${VAR}` reads it.

const COMPOSE_FILE = /^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/u;

export function isComposeFile(relative: string): boolean {
  return COMPOSE_FILE.test(path.posix.basename(relative));
}

// `${VAR}`, `${VAR:-default}`, `$VAR`; `$$` is a literal dollar.
export function interpolations(text: string): string[] {
  const names: string[] = [];
  for (const match of text.replace(/\$\$/gu, "").matchAll(/\$\{([A-Za-z_]\w*)(?:[:?+-][^}]*)?\}|\$([A-Za-z_]\w*)/gu)) {
    const name = match[1] ?? match[2]!;
    if (isEnvName(name)) names.push(name);
  }
  return names;
}

export async function addCompose(ctx: Context, relative: string, fileId: string, text: string): Promise<void> {
  const services = asMap(mapGet(asMap(await readYaml(text)), "services")?.value);
  if (!services) return;
  const directory = path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
  const declare = (name: string, line: number) => ctx.graph.addRelationship({ from: ctx.repoId, to: envVar(ctx.graph, name), type: "DECLARES_ENV", properties: { file: relative, line } });

  for (const service of services.entries) {
    const body = asMap(service.value);
    if (!body) continue;
    const command = commandText(mapGet(body, "entrypoint")?.value) ?? commandText(mapGet(body, "command")?.value);
    const image = asText(mapGet(body, "image")?.value);
    const id = entrypoint(ctx, fileId, `entrypoint:compose-service:${relative}:${service.key}`, {
      kind: "compose-service",
      trigger: service.key,
      library: "docker-compose",
      line: service.line,
      handlerName: (command ?? image ?? (mapGet(body, "build") ? "build" : null))?.slice(0, 300) ?? null,
    });

    // `build: ./api` or `build: { context, dockerfile }`: the Dockerfile the service runs.
    const build = mapGet(body, "build")?.value;
    let context = directory;
    if (build) {
      const buildMap = asMap(build);
      const contextText = buildMap ? asText(mapGet(buildMap, "context")?.value) ?? "." : asText(build) ?? ".";
      const dockerfile = (buildMap ? asText(mapGet(buildMap, "dockerfile")?.value) : null) ?? "Dockerfile";
      context = path.posix.normalize(path.posix.join(directory, contextText));
      const dockerfilePath = path.posix.normalize(path.posix.join(context, dockerfile));
      const target = ctx.fileIds.get(dockerfilePath === "." ? "" : dockerfilePath);
      if (target) ctx.graph.addRelationship({ from: id, to: target, type: "RUNS", properties: { line: service.line, command: `build ${dockerfilePath}`.slice(0, 200) } });
    }
    if (command) {
      const cwds = [...new Set([context === "." ? "" : context, directory, ""])];
      ctx.pending.push({ from: id, cwds, commands: splitCommands(command).map((part) => ({ text: part, line: service.line })) });
    }

    // `environment:` as a mapping or as `KEY=value` / `KEY` items.
    const environment = mapGet(body, "environment")?.value;
    for (const entry of asMap(environment)?.entries ?? []) declare(entry.key, entry.line);
    for (const item of asSeq(environment)?.items ?? []) {
      const name = /^([A-Za-z_]\w*)/u.exec(asText(item.value) ?? "")?.[1];
      if (name) declare(name, item.line);
    }

    // `env_file:` names that `.env*` files do not already declare.
    const envFiles = mapGet(body, "env_file")?.value;
    const paths = asText(envFiles) !== null
      ? [asText(envFiles)!]
      : (asSeq(envFiles)?.items ?? []).flatMap((item) => [asText(item.value) ?? asText(mapGet(asMap(item.value), "path")?.value)].filter((entry): entry is string => entry !== null));
    for (const envPath of paths) {
      const target = path.posix.normalize(path.posix.join(directory, envPath));
      if (isEnvFile(target) || !ctx.fileIds.has(target)) continue;
      const content = await readText(path.join(ctx.rootPath, target));
      if (content === null) continue;
      for (const entry of parseEnvFile(content)) {
        ctx.graph.addRelationship({ from: ctx.repoId, to: envVar(ctx.graph, entry.name), type: "DECLARES_ENV", properties: { file: target, line: entry.line } });
      }
    }

    // `${VAR}` anywhere in the service reads the host's env.
    const seen = new Set<string>();
    for (const scalar of scalars(service.value)) {
      for (const name of interpolations(scalar.text)) {
        const key = `${name}:${scalar.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ctx.graph.addRelationship({ from: id, to: envVar(ctx.graph, name), type: "USES_ENV", properties: { line: scalar.line, access: `\${${name}}` } });
      }
    }
  }

  // `${VAR}` outside the services (volumes, networks, top-level names).
  const outside = asMap(await readYaml(text))?.entries.filter((entry) => entry.key !== "services") ?? [];
  for (const entry of outside) {
    for (const scalar of scalars(entry.value)) {
      for (const name of interpolations(scalar.text)) {
        ctx.graph.addRelationship({ from: fileId, to: envVar(ctx.graph, name), type: "USES_ENV", properties: { line: scalar.line, access: `\${${name}}` } });
      }
    }
  }
}

// `command: node x.js` or `command: ["node", "x.js"]`.
function commandText(value: YValue | undefined): string | null {
  const text = asText(value);
  if (text !== null) return text;
  const items = asSeq(value)?.items.map((item) => asText(item.value)).filter((item): item is string => item !== null);
  return items && items.length > 0 ? items.join(" ") : null;
}
