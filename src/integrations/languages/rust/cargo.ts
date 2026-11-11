import { readFile } from "node:fs/promises";
import path from "node:path";

// The parts of a Cargo.toml the scan needs, read with a small tolerant TOML
// reader (there is no TOML grammar): packages, the crate roots they build and
// the dependencies that name another crate of the scan.
export type CargoPackage = {
  name: string;
  // Directory of the Cargo.toml, relative to the scan root ("." for the root).
  dir: string;
  // The name `use` paths start with (`-` becomes `_`).
  libName: string;
  libPath: string | null;
  binPaths: string[];
  // Directories whose `*.rs` files are crate roots of their own (tests, examples, benches).
  rootDirectories: string[];
  // `use` identifier → name of the package it points at.
  dependencies: Map<string, string>;
};

export type CargoConfig = {
  packages: CargoPackage[];
};

type TomlValue = string | boolean | number | TomlValue[] | { [key: string]: TomlValue };
type TomlTable = { [key: string]: TomlValue };

const dependencySections = new Set(["dependencies", "dev-dependencies", "build-dependencies", "workspace.dependencies"]);

export async function readCargoConfig(rootPath: string, relativePaths: Iterable<string>): Promise<CargoConfig> {
  const manifests: Array<{ dir: string; toml: TomlTable }> = [];
  for (const relativePath of relativePaths) {
    if (path.posix.basename(relativePath) !== "Cargo.toml") continue;
    let raw: string;
    try {
      raw = await readFile(path.join(rootPath, relativePath), "utf8");
    } catch {
      continue;
    }
    manifests.push({ dir: path.posix.dirname(relativePath), toml: parseToml(raw) });
  }

  // `foo.workspace = true` takes the path of `[workspace.dependencies]`.
  const workspaceDependencies = new Map<string, { path: string | null; package: string | null }>();
  for (const { dir, toml } of manifests) {
    const table = getTable(getTable(toml, "workspace"), "dependencies");
    for (const [name, value] of Object.entries(table)) {
      const entry = dependencyEntry(value);
      workspaceDependencies.set(name, {
        path: entry.path === null ? null : path.posix.normalize(path.posix.join(dir, entry.path)),
        package: entry.package,
      });
    }
  }

  const packages: CargoPackage[] = [];
  for (const { dir, toml } of manifests) {
    const section = getTable(toml, "package");
    const name = typeof section.name === "string" ? section.name : null;
    if (name === null) continue;
    const lib = getTable(toml, "lib");
    const libName = typeof lib.name === "string" ? lib.name : name;
    packages.push({
      name,
      dir,
      libName: libName.replaceAll("-", "_"),
      libPath: typeof lib.path === "string" ? joinPath(dir, lib.path) : joinPath(dir, "src/lib.rs"),
      binPaths: [
        joinPath(dir, "src/main.rs"),
        ...(Array.isArray(toml.bin) ? toml.bin : []).flatMap((bin) => {
          const value = typeof bin === "object" && !Array.isArray(bin) ? bin.path : undefined;
          return typeof value === "string" ? [joinPath(dir, value)] : [];
        }),
      ],
      rootDirectories: ["src/bin", "tests", "examples", "benches"].map((child) => joinPath(dir, child)),
      dependencies: new Map(),
    });
  }

  const byDir = new Map(packages.map((entry) => [entry.dir, entry]));
  for (const { dir, toml } of manifests) {
    const owner = byDir.get(dir);
    if (!owner) continue;
    for (const section of dependencySections) {
      if (section === "workspace.dependencies") continue;
      addDependencies(owner, getTable(toml, section), dir, workspaceDependencies, byDir);
    }
    for (const target of Object.values(getTable(toml, "target"))) {
      if (typeof target !== "object" || Array.isArray(target)) continue;
      for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
        addDependencies(owner, getTable(target, section), dir, workspaceDependencies, byDir);
      }
    }
  }
  return { packages };
}

function addDependencies(
  owner: CargoPackage,
  table: TomlTable,
  dir: string,
  workspaceDependencies: Map<string, { path: string | null; package: string | null }>,
  byDir: Map<string, CargoPackage>,
): void {
  for (const [key, value] of Object.entries(table)) {
    const entry = dependencyEntry(value);
    let target = entry.package;
    let dependencyPath = entry.path === null ? null : path.posix.normalize(path.posix.join(dir, entry.path));
    if (entry.workspace) {
      const shared = workspaceDependencies.get(key);
      dependencyPath = shared?.path ?? null;
      target = shared?.package ?? target;
    }
    const pointed = dependencyPath === null ? undefined : byDir.get(dependencyPath);
    owner.dependencies.set(key.replaceAll("-", "_"), pointed?.name ?? target ?? key);
  }
}

function dependencyEntry(value: TomlValue | undefined): { path: string | null; package: string | null; workspace: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { path: null, package: null, workspace: false };
  return {
    path: typeof value.path === "string" ? value.path : null,
    package: typeof value.package === "string" ? value.package : null,
    workspace: value.workspace === true,
  };
}

function joinPath(dir: string, child: string): string {
  return path.posix.normalize(dir === "." ? child : path.posix.join(dir, child));
}

function getTable(table: TomlTable, key: string): TomlTable {
  const value = table[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

// A tolerant TOML reader: tables, arrays of tables, dotted keys, strings,
// numbers, booleans, arrays and inline tables. Anything it cannot read is
// skipped, never an error.
export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]!).trim();
    if (line === "") continue;

    const arrayTable = /^\[\[\s*([^\]]+?)\s*\]\]$/u.exec(line);
    if (arrayTable) {
      const keys = splitKey(arrayTable[1]!);
      const parent = descend(root, keys.slice(0, -1));
      const last = keys[keys.length - 1]!;
      const list = Array.isArray(parent[last]) ? parent[last] as TomlValue[] : [];
      const entry: TomlTable = {};
      list.push(entry);
      parent[last] = list;
      current = entry;
      continue;
    }
    const table = /^\[\s*([^\]]+?)\s*\]$/u.exec(line);
    if (table) {
      current = descend(root, splitKey(table[1]!));
      continue;
    }

    const equals = findEquals(line);
    if (equals < 0) continue;
    const keys = splitKey(line.slice(0, equals));
    let value = line.slice(equals + 1).trim();
    // Arrays and inline tables may continue on the next lines.
    while (unbalanced(value) && index + 1 < lines.length) {
      index += 1;
      value += ` ${stripComment(lines[index]!).trim()}`;
    }
    const parsed = parseValue(value);
    if (parsed === undefined || keys.length === 0) continue;
    descend(current, keys.slice(0, -1))[keys[keys.length - 1]!] = parsed;
  }
  return root;
}

function descend(table: TomlTable, keys: string[]): TomlTable {
  let current = table;
  for (const key of keys) {
    let next = current[key];
    if (Array.isArray(next)) next = next[next.length - 1];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      next = {};
      current[key] = next;
    }
    current = next;
  }
  return current;
}

function splitKey(raw: string): string[] {
  const keys: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+)/gu;
  for (const match of raw.matchAll(pattern)) keys.push(match[1] ?? match[2] ?? match[3]!);
  return keys;
}

function findEquals(line: string): number {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "=") {
      return index;
    }
  }
  return -1;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\" && quote === "\"") index += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function unbalanced(value: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
  }
  return depth > 0;
}

function parseValue(raw: string): TomlValue | undefined {
  const value = raw.trim();
  if (value.startsWith("\"")) return /^"((?:[^"\\]|\\.)*)"/u.exec(value)?.[1]?.replace(/\\(.)/gu, "$1");
  if (value.startsWith("'")) return /^'([^']*)'/u.exec(value)?.[1];
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?\d/u.test(value)) return Number(value.replaceAll("_", "")) || 0;
  if (value.startsWith("[")) {
    return splitTopLevel(value.slice(1, value.lastIndexOf("]") < 0 ? undefined : value.lastIndexOf("]")))
      .map(parseValue)
      .filter((entry): entry is TomlValue => entry !== undefined);
  }
  if (value.startsWith("{")) {
    const table: TomlTable = {};
    for (const part of splitTopLevel(value.slice(1, value.lastIndexOf("}") < 0 ? undefined : value.lastIndexOf("}")))) {
      const equals = findEquals(part);
      if (equals < 0) continue;
      const keys = splitKey(part.slice(0, equals));
      const parsed = parseValue(part.slice(equals + 1));
      if (parsed === undefined || keys.length === 0) continue;
      descend(table, keys.slice(0, -1))[keys[keys.length - 1]!] = parsed;
    }
    return table;
  }
  return undefined;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}
