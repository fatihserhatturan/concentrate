import path from "node:path";
import type { JsTsPathMapping } from "./config.js";

export function parseTsconfig(rawConfig: string): {
  baseUrl: string | null;
  paths: JsTsPathMapping[];
} {
  const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(rawConfig)) as {
    compilerOptions?: {
      baseUrl?: unknown;
      paths?: unknown;
    };
  };
  const compilerOptions = parsed.compilerOptions ?? {};
  const baseUrl = typeof compilerOptions.baseUrl === "string"
    ? toPosixPath(compilerOptions.baseUrl)
    : null;

  return {
    baseUrl,
    paths: parseTsconfigPaths(compilerOptions.paths, baseUrl),
  };
}

function parseTsconfigPaths(paths: unknown, baseUrl: string | null): JsTsPathMapping[] {
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return [];
  }

  return Object.entries(paths)
    .filter((entry): entry is [string, string[]] => (
      typeof entry[0] === "string"
      && Array.isArray(entry[1])
      && entry[1].every((target) => typeof target === "string")
    ))
    .map(([pattern, targets]) => ({
      pattern,
      targets: targets.map((target) => {
        const normalizedTarget = toPosixPath(target);
        return baseUrl ? path.posix.join(baseUrl, normalizedTarget) : normalizedTarget;
      }),
    }));
}

function stripJsonCommentsAndTrailingCommas(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
