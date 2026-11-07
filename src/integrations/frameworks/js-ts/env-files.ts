import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { publicPrefixes } from "../../languages/js-ts/env-config.js";

// Env files whose values resolve request URLs, in order of precedence.
export const ENV_VALUE_FILES = [".env.development.local", ".env.local", ".env.development", ".env", ".env.example", ".env.sample"];

// Directory (relative, "" for the root) → env file name → values.
export type EnvFiles = Map<string, Map<string, Map<string, string>>>;

// `.env` and `.env.<anything>` among the files the scan discovered
// (gitignored ones are not discovered).
export function isEnvFile(file: string): boolean {
  const name = path.basename(file);
  return name === ".env" || name.startsWith(".env.");
}

export async function readEnvFiles(rootPath: string, files: readonly string[]): Promise<EnvFiles> {
  const result: EnvFiles = new Map();
  for (const file of files) {
    const name = path.basename(file);
    if (!ENV_VALUE_FILES.includes(name)) continue;
    const content = await readText(file);
    if (content === null) continue;
    const directory = relativePath(rootPath, path.dirname(file));
    const byName = result.get(directory) ?? new Map<string, Map<string, string>>();
    byName.set(name, new Map(parseEnvFile(content).map((entry) => [entry.name, entry.value])));
    result.set(directory, byName);
  }
  return result;
}

// `KEY=value`, `export KEY="value"`; `#` comments.
export function parseEnvFile(content: string): Array<{ name: string; value: string; line: number }> {
  const entries: Array<{ name: string; value: string; line: number }> = [];
  content.split(/\r?\n/u).forEach((line, index) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/u.exec(line);
    if (!match) return;
    const raw = match[2]!.trim();
    const quoted = /^(["'`])(.*)\1$/u.exec(raw);
    entries.push({ name: match[1]!, value: quoted ? quoted[2]! : raw.replace(/\s+#.*$/u, ""), line: index + 1 });
  });
  return entries;
}

// The variables each env file declares: an EnvVar (shared with the reads of
// the same name) and `DECLARES_ENV` from the Repo with the file and line.
// Values are not stored, since env files hold secrets. Prisma schemas read
// env too (`url = env("DATABASE_URL")`) and have no File node, so those reads
// are `USES_ENV` from the Repo with their file.
export const envFilesContributor: ISemanticContributor = {
  async contribute(graph, rootPath, _report, files) {
    const repo = graph.nodes.find((node) => node.label === "Repo");
    if (!repo) return;
    for (const file of files) {
      const env = isEnvFile(file);
      if (!env && !file.endsWith(".prisma")) continue;
      const content = await readText(file);
      if (content === null) continue;
      const relative = relativePath(rootPath, file);
      if (env) {
        for (const { name, line } of parseEnvFile(content)) {
          graph.addRelationship({ from: repo.id, to: envVar(graph, name), type: "DECLARES_ENV", properties: { file: relative, line } });
        }
      } else {
        content.split(/\r?\n/u).forEach((text, index) => {
          for (const match of text.matchAll(/\benv\(\s*"([A-Za-z_]\w*)"\s*\)/gu)) {
            graph.addRelationship({ from: repo.id, to: envVar(graph, match[1]!), type: "USES_ENV", properties: { file: relative, line: index + 1, access: "prisma env()" } });
          }
        });
      }
    }
  },
};

export function envVar(graph: IGraphContributor, name: string): string {
  const id = `env:${name}`;
  graph.addNode({ id, label: "EnvVar", properties: { name, ...(publicPrefixes.test(name) ? { isPublic: true } : {}) } });
  return id;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function relativePath(rootPath: string, file: string): string {
  return path.relative(rootPath, file).split(path.sep).join("/");
}
