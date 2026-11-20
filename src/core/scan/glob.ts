import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Glob matching and directory walking on `node:fs` only.
 *
 * Supported syntax: `**` (whole path segments), `*`, `?`, `[...]` / `[!...]`,
 * `{a,b}` (nestable) and `\` escapes. Dotfiles always match, like
 * fast-glob's `dot: true`. Paths are relative and POSIX-separated.
 */

export type GlobOptions = {
  /** Expand `{a,b}` alternatives. Gitignore patterns turn this off. */
  braces?: boolean;
};

const regexCache = new Map<string, RegExp>();

export function compileGlob(pattern: string, options: GlobOptions = {}): RegExp {
  const braces = options.braces ?? true;
  const key = `${braces ? "b" : "-"}:${pattern}`;
  let regex = regexCache.get(key);
  if (!regex) {
    regex = new RegExp(`^${globToRegexSource(pattern, braces)}$`, "s");
    regexCache.set(key, regex);
  }
  return regex;
}

export function matchesGlob(pattern: string, relativePath: string, options?: GlobOptions): boolean {
  return compileGlob(pattern, options).test(relativePath);
}

function globToRegexSource(pattern: string, braces: boolean): string {
  let source = "";
  let braceDepth = 0;

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;

    if (char === "\\") {
      const next = pattern[i + 1];
      if (next !== undefined) {
        source += escapeRegex(next);
        i += 1;
      } else {
        source += "\\\\";
      }
      continue;
    }

    if (char === "*") {
      const segmentStart = i === 0 || pattern[i - 1] === "/";
      if (pattern[i + 1] === "*" && segmentStart && (i + 2 === pattern.length || pattern[i + 2] === "/")) {
        if (i + 2 === pattern.length) {
          source += ".*";
          i += 1;
        } else {
          // `**/` matches zero or more whole directories.
          source += "(?:[^/]*/)*";
          i += 2;
        }
        continue;
      }
      while (pattern[i + 1] === "*") i += 1;
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "[") {
      const end = findClassEnd(pattern, i);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end);
      let negated = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negated = true;
        body = body.slice(1);
      }
      const escaped = body.replace(/\\(.)/g, "$1").replace(/[\\\]^]/g, "\\$&");
      source += negated ? `[^/${escaped}]` : `[${escaped}]`;
      i = end;
      continue;
    }

    if (braces && char === "{" && hasClosingBrace(pattern, i)) {
      braceDepth += 1;
      source += "(?:";
      continue;
    }
    if (braces && braceDepth > 0 && char === "}") {
      braceDepth -= 1;
      source += ")";
      continue;
    }
    if (braces && braceDepth > 0 && char === ",") {
      source += "|";
      continue;
    }

    source += escapeRegex(char);
  }

  return source;
}

function findClassEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === "!" || pattern[i] === "^") i += 1;
  if (pattern[i] === "]") i += 1;
  for (; i < pattern.length; i += 1) {
    if (pattern[i] === "\\") {
      i += 1;
    } else if (pattern[i] === "]") {
      return i;
    } else if (pattern[i] === "/") {
      return -1;
    }
  }
  return -1;
}

function hasClosingBrace(pattern: string, start: number): boolean {
  let depth = 0;
  for (let i = start; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const GLOB_CHARS = /[*?[{\\]/;

/** A compiled glob that can also tell whether a directory may contain matches. */
export type GlobMatcher = {
  pattern: string;
  /** Leading literal directory, e.g. `packages` for `packages/*\/package.json`; `""` when none. */
  base: string;
  matches: (relativePath: string) => boolean;
  mayContain: (relativeDirectory: string) => boolean;
};

export function createGlobMatcher(pattern: string): GlobMatcher {
  const normalized = pattern.replace(/^\.\//, "");
  const regex = compileGlob(normalized);
  const segments = splitSegments(normalized);
  const segmentRegexes = segments?.map((segment) => (segment === "**" ? null : compileGlob(segment)));

  const baseSegments: string[] = [];
  for (const segment of segments?.slice(0, -1) ?? []) {
    if (GLOB_CHARS.test(segment)) break;
    baseSegments.push(segment);
  }

  return {
    pattern: normalized,
    base: baseSegments.join("/"),
    matches: (relativePath) => regex.test(relativePath),
    mayContain: (relativeDirectory) => {
      if (!segmentRegexes || relativeDirectory === "") return true;
      const parts = relativeDirectory.split("/");
      for (let i = 0; i < parts.length; i += 1) {
        const segment = segmentRegexes[i];
        if (segment === null) return true;
        // A directory at the file segment's depth cannot contain a match.
        if (segment === undefined || i === segmentRegexes.length - 1) return false;
        if (!segment.test(parts[i]!)) return false;
      }
      return true;
    },
  };
}

/** Split on `/` outside braces and classes; `null` when a brace spans segments. */
function splitSegments(pattern: string): string[] | null {
  const segments = pattern.split("/");
  for (const segment of segments) {
    const opens = (segment.match(/(?<!\\)\{/g) ?? []).length;
    const closes = (segment.match(/(?<!\\)\}/g) ?? []).length;
    if (opens !== closes) return null;
  }
  return segments;
}

export type WalkOptions = {
  /** Directories (relative, POSIX) to start from; defaults to the root. Missing ones are skipped. */
  start?: string[];
  /** Called once per directory, with its entry names, before the entries are filtered (e.g. to load a nested `.gitignore`). */
  enterDirectory?: (relativeDirectory: string, entryNames: string[]) => Promise<void> | void;
  /** Return false to skip a directory (with its whole subtree) or a file. */
  accept?: (relativePath: string, isDirectory: boolean) => boolean;
};

/**
 * Recursively list files under `rootPath` as sorted relative POSIX paths.
 * Symlinked files are listed; symlinked directories are not entered, which
 * rules out cycles.
 */
export async function walkFiles(rootPath: string, options: WalkOptions = {}): Promise<string[]> {
  const files: string[] = [];
  const accept = options.accept ?? (() => true);

  async function visit(relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(rootPath, relativeDirectory), { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    await options.enterDirectory?.(relativeDirectory, entries.map((entry) => entry.name));

    const subdirectories: string[] = [];
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        isFile = await stat(path.join(rootPath, relativePath)).then((target) => target.isFile(), () => false);
      }
      if (entry.isDirectory()) {
        if (accept(relativePath, true)) subdirectories.push(relativePath);
      } else if (isFile && accept(relativePath, false)) {
        files.push(relativePath);
      }
    }
    await Promise.all(subdirectories.map(visit));
  }

  await Promise.all(minimalStarts(options.start ?? [""]).map(visit));
  return files.sort();
}

/** Drop start directories nested inside another start directory. */
function minimalStarts(starts: string[]): string[] {
  const unique = [...new Set(starts)].sort();
  if (unique.includes("")) return [""];
  return unique.filter((start, index) => !unique.slice(0, index).some((other) => start.startsWith(`${other}/`)));
}
