import path from "node:path";
import type { JsTsPathMapping } from "./config.js";

export function parseTsconfig(rawConfig: string): {
  baseUrl: string | null;
  paths: JsTsPathMapping[];
  extendsPath: string | null;
  hasBaseUrl: boolean;
  hasPaths: boolean;
} {
  const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(rawConfig)) as {
    extends?: unknown;
    compilerOptions?: {
      baseUrl?: unknown;
      paths?: unknown;
    };
  };
  const compilerOptions = parsed.compilerOptions ?? {};
  const hasBaseUrl = "baseUrl" in compilerOptions;
  const hasPaths = "paths" in compilerOptions;
  const baseUrl = hasBaseUrl && typeof compilerOptions.baseUrl === "string"
    ? toPosixPath(compilerOptions.baseUrl)
    : null;

  return {
    baseUrl,
    paths: parseTsconfigPaths(compilerOptions.paths, baseUrl),
    extendsPath: typeof parsed.extends === "string" ? parsed.extends : null,
    hasBaseUrl,
    hasPaths,
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
  let output = "";
  let inString = false;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const next = value[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < value.length && value[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return stripTrailingCommas(output);
}

function stripTrailingCommas(value: string): string {
  let output = "";
  let inString = false;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < value.length && /\s/u.test(value[lookahead]!)) {
        lookahead += 1;
      }
      if (value[lookahead] === "}" || value[lookahead] === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
