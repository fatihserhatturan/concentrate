import path from "node:path";
import type { DockerInstruction } from "../../languages/plain/dockerfile.js";
import { tokenize } from "./commands.js";

// Where a Dockerfile puts the project's files in the image, so a command that
// names a path inside the container (`/app/start.sh`) can be linked to the
// file of the repository it came from. Only `COPY` and `ADD` from the build
// context count (not `--from=` another stage); a copied directory maps its
// whole tree.

export type ContainerMap = {
  // Container path of a copied file → file of the repository.
  files: Map<string, string>;
  // A copied directory: container path → directory of the repository.
  directories: Array<{ container: string; repo: string }>;
};

export function containerMap(instructions: readonly DockerInstruction[], context: string, exists: (relative: string) => boolean): ContainerMap {
  const map: ContainerMap = { files: new Map(), directories: [] };
  let workdir = "/";
  for (const { instruction, args } of instructions) {
    if (instruction === "WORKDIR") {
      const target = args.trim();
      if (!/[$`]/u.test(target)) workdir = path.posix.normalize(target.startsWith("/") ? target : path.posix.join(workdir, target));
      continue;
    }
    if (instruction !== "COPY" && instruction !== "ADD") continue;
    const tokens = args.startsWith("[") ? jsonTokens(args) : tokenize(args);
    if (tokens.some((token) => token.startsWith("--from"))) continue;
    const words = tokens.filter((token) => !token.startsWith("--"));
    if (words.length < 2) continue;
    const dest = words[words.length - 1]!;
    const sources = words.slice(0, -1);
    const destination = path.posix.normalize(dest.startsWith("/") ? dest : path.posix.join(workdir, dest));
    const intoDirectory = dest.endsWith("/") || dest === "." || sources.length > 1;
    for (const source of sources) {
      if (/^[a-z]+:\/\//iu.test(source) || /[*?[\]$]/u.test(source)) continue;
      const repo = path.posix.normalize(path.posix.join(context, source.replace(/^\.\//u, "")));
      if (exists(repo)) {
        map.files.set(intoDirectory ? path.posix.join(destination, path.posix.basename(repo)) : destination, repo);
      } else {
        map.directories.push({ container: destination, repo: repo === "." ? "" : repo });
      }
    }
  }
  // The most specific directory first.
  map.directories.sort((a, b) => b.container.length - a.container.length);
  return map;
}

// The repository file a container path comes from, or null.
export function resolveContainerPath(map: ContainerMap, containerPath: string, exists: (relative: string) => boolean): string | null {
  const normalized = path.posix.normalize(containerPath);
  const file = map.files.get(normalized);
  if (file !== undefined) return file;
  for (const { container, repo } of map.directories) {
    if (normalized !== container && !normalized.startsWith(container === "/" ? "/" : `${container}/`)) continue;
    const rest = normalized.slice(container === "/" ? 1 : container.length + 1);
    const candidate = path.posix.normalize(path.posix.join(repo, rest));
    if (rest !== "" && exists(candidate)) return candidate;
  }
  return null;
}

function jsonTokens(args: string): string[] {
  try {
    const parsed = JSON.parse(args) as unknown;
    return Array.isArray(parsed) && parsed.every((part) => typeof part === "string") ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
