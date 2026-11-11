import path from "node:path";
import type { CargoConfig, CargoPackage } from "./cargo.js";

// What the module tree needs of an `Import` node.
export type RustImportRecord = {
  importerFile: string; // relative path
  source: string;
  isModule: boolean;
  isReExport: boolean;
  isWildcard: boolean;
  alias: string | null;
  inlineModules: string[];
  pathAttribute: string | null;
};

type RustModule = {
  key: string;
  file: string;
  inline: string[];
  crateRoot: string;
  parent: string | null;
  children: Map<string, string>;
  // `pub use` of a path: name (alias or last segment) → path segments.
  reExports: Map<string, string[]>;
  globs: string[][];
};

export type RustResolution = { files: string[]; expected: boolean };

export type RustModuleTree = {
  resolveImport(record: RustImportRecord): RustResolution;
  // The file of the module a path names (`crate::a::b`), and how many of its
  // segments were modules; the rest name an item inside that module.
  resolvePath(segments: string[], importerFile: string, inlineModules: string[]): { file: string; consumed: number } | null;
  // The crate a file belongs to, as the root file of that crate.
  crateOf(file: string): string | null;
  modulePath(file: string): string[] | null;
};

function isInsideRoot(file: string): boolean {
  return /(^|\/)(tests|examples|benches|src\/bin)\//u.test(file);
}

const modFileNames = new Set(["mod.rs", "lib.rs", "main.rs"]);

export function createRustModuleTree(
  config: CargoConfig,
  records: RustImportRecord[],
  hasFile: (relativePath: string) => boolean,
  filesInDirectory: (dir: string) => string[],
): RustModuleTree {
  const modules = new Map<string, RustModule>();
  const importsByFile = new Map<string, RustImportRecord[]>();
  for (const record of records) {
    const list = importsByFile.get(record.importerFile) ?? [];
    list.push(record);
    importsByFile.set(record.importerFile, list);
  }

  // Crate roots: each is the top of its own module tree.
  const roots = new Map<string, CargoPackage>();
  for (const pkg of config.packages) {
    const candidates = [pkg.libPath, ...pkg.binPaths].filter((value): value is string => value !== null);
    for (const candidate of candidates) {
      if (hasFile(candidate) && !roots.has(candidate)) roots.set(candidate, pkg);
    }
    for (const dir of pkg.rootDirectories) {
      for (const file of filesInDirectory(dir)) {
        if (file.endsWith(".rs") && !roots.has(file)) roots.set(file, pkg);
        // tests/common/mod.rs is a module of the tests, not a crate: only
        // direct children and `dir/main.rs` are roots.
      }
    }
  }
  // Without a Cargo.toml (a loose sample, a vendored snippet) a `lib.rs` or
  // `main.rs` is still the root of a crate of its own.
  for (const file of importsByFile.keys()) {
    const name = path.posix.basename(file);
    if ((name === "lib.rs" || name === "main.rs") && !roots.has(file) && !isInsideRoot(file)) {
      const dir = path.posix.dirname(file);
      const crateName = (dir === "." ? "crate" : path.posix.basename(dir === "src" ? path.posix.dirname(dir) : dir)).replaceAll("-", "_");
      roots.set(file, { name: crateName, dir, libName: crateName, libPath: file, binPaths: [], rootDirectories: [], dependencies: new Map() });
    }
  }
  const packageByCrateRoot = roots;

  const claimed = new Set<string>();
  const ensure = (file: string, inline: string[], crateRoot: string, parent: string | null): RustModule => {
    const key = moduleKey(file, inline);
    let module = modules.get(key);
    if (!module) {
      module = { key, file, inline, crateRoot, parent, children: new Map(), reExports: new Map(), globs: [] };
      modules.set(key, module);
    }
    return module;
  };

  const queue: Array<{ file: string; crateRoot: string }> = [];
  for (const root of roots.keys()) {
    if (claimed.has(root)) continue;
    claimed.add(root);
    ensure(root, [], root, null);
    queue.push({ file: root, crateRoot: root });
  }

  while (queue.length > 0) {
    const { file, crateRoot } = queue.shift()!;
    const baseDirectory = moduleDirectory(file, roots.has(file));
    for (const record of importsByFile.get(file) ?? []) {
      // The module the declaration sits in, created through its inline parents.
      let parent = ensure(file, [], crateRoot, null);
      for (let depth = 0; depth < record.inlineModules.length; depth += 1) {
        const name = record.inlineModules[depth]!;
        const inline = record.inlineModules.slice(0, depth + 1);
        const next = ensure(file, inline, crateRoot, parent.key);
        parent.children.set(name, next.key);
        parent = next;
      }

      if (record.isModule) {
        const name = record.source;
        const directory = record.inlineModules.length === 0 ? baseDirectory : joinPath(baseDirectory, record.inlineModules.join("/"));
        const candidates = record.pathAttribute
          ? [joinPath(record.inlineModules.length === 0 ? path.posix.dirname(file) : directory, record.pathAttribute)]
          : [joinPath(directory, `${name}.rs`), joinPath(directory, `${name}/mod.rs`)];
        const target = candidates.find((candidate) => hasFile(candidate));
        if (target === undefined) continue;
        if (!claimed.has(target)) {
          claimed.add(target);
          const child = ensure(target, [], crateRoot, parent.key);
          parent.children.set(name, child.key);
          queue.push({ file: target, crateRoot });
        } else {
          // A file already mounted (a module shared by two crates): reuse it.
          const existing = modules.get(moduleKey(target, []));
          if (existing && !parent.children.has(name)) parent.children.set(name, existing.key);
        }
      } else if (record.isReExport) {
        const segments = record.source.split("::");
        if (record.isWildcard) parent.globs.push(segments);
        else parent.reExports.set(record.alias ?? segments[segments.length - 1]!, segments);
      }
    }
  }

  const packageOfModule = (module: RustModule): CargoPackage | undefined => packageByCrateRoot.get(module.crateRoot);

  const packageByLibName = (name: string): CargoPackage | undefined => config.packages.find((pkg) => pkg.libName === name);
  const crateLibRoot = (pkg: CargoPackage): string | null => {
    const lib = pkg.libPath;
    return lib !== null && modules.has(moduleKey(lib, [])) ? lib : null;
  };

  // A child module, or the target of a `pub use` / glob re-export, of a module.
  const lookup = (module: RustModule, name: string, depth: number, seen: Set<string>): RustModule | null => {
    const child = module.children.get(name);
    if (child) return modules.get(child) ?? null;
    if (depth > 8 || seen.has(module.key)) return null;
    seen.add(module.key);
    const reExport = module.reExports.get(name);
    if (reExport) {
      const target = walk(reExport, module, depth + 1, seen);
      if (target && target.consumed === reExport.length) return target.module;
    }
    for (const glob of module.globs) {
      const target = walk(glob, module, depth + 1, seen);
      if (target && target.consumed === glob.length) {
        const found = lookup(target.module, name, depth + 1, seen);
        if (found) return found;
      }
    }
    return null;
  };

  const walk = (
    segments: string[],
    from: RustModule,
    depth: number,
    seen: Set<string> = new Set(),
  ): { module: RustModule; consumed: number } | null => {
    if (segments.length === 0) return { module: from, consumed: 0 };
    let current = from;
    let index = 0;
    const first = segments[0]!;
    if (first === "crate") {
      current = modules.get(moduleKey(from.crateRoot, [])) ?? from;
      index = 1;
    } else if (first === "self" || first === "super") {
      while (segments[index] === "self" || segments[index] === "super") {
        if (segments[index] === "super") {
          const parent = current.parent === null ? undefined : modules.get(current.parent);
          if (!parent) return null;
          current = parent;
        }
        index += 1;
      }
    } else if (current.children.has(first) || lookup(current, first, depth, new Set(seen))) {
      index = 0;
    } else {
      const pkg = packageOfModule(from);
      const targetName = first === pkg?.libName ? pkg.name : pkg?.dependencies.get(first);
      const target = targetName !== undefined
        ? config.packages.find((candidate) => candidate.name === targetName)
        : packageByLibName(first);
      const libRoot = target ? crateLibRoot(target) : null;
      if (!libRoot) return null;
      current = modules.get(moduleKey(libRoot, []))!;
      index = 1;
    }
    for (; index < segments.length; index += 1) {
      const next = lookup(current, segments[index]!, depth, new Set(seen));
      if (!next) {
        // An item `pub use`d from another module lives in that module's file.
        const reExport = depth < 8 ? current.reExports.get(segments[index]!) : undefined;
        const target = reExport ? walk(reExport, current, depth + 1, new Set(seen)) : null;
        if (target) return { module: target.module, consumed: index + 1 };
        break;
      }
      current = next;
    }
    return { module: current, consumed: index };
  };

  const moduleFor = (file: string, inline: string[]): RustModule | null => {
    return modules.get(moduleKey(file, inline)) ?? modules.get(moduleKey(file, [])) ?? null;
  };

  return {
    resolveImport(record) {
      const from = moduleFor(record.importerFile, record.inlineModules);
      if (!from) return { files: [], expected: false };
      if (record.isModule) {
        const child = modules.get(from.children.get(record.source) ?? "");
        return { files: child ? [child.file] : [], expected: true };
      }
      const segments = record.source.split("::");
      const first = segments[0]!;
      const result = walk(segments, from, 0);
      // Paths that must resolve inside the scan: crate/self/super, a module
      // declared here and another crate of the workspace. std and external
      // crates are not counted as unresolved.
      const pkg = packageOfModule(from);
      const expected = first === "crate" || first === "self" || first === "super"
        || from.children.has(first)
        || first === pkg?.libName
        || pkg?.dependencies.has(first) === true && config.packages.some((candidate) => candidate.name === pkg.dependencies.get(first))
        || (pkg === undefined || !pkg.dependencies.has(first)) && packageByLibName(first) !== undefined;
      if (!result || (result.consumed === 0 && first !== "self" && first !== "super")) {
        return { files: [], expected };
      }
      return { files: [result.module.file], expected };
    },
    resolvePath(segments, importerFile, inlineModules) {
      const from = moduleFor(importerFile, inlineModules);
      if (!from) return null;
      const result = walk(segments, from, 0);
      if (!result) return null;
      return { file: result.module.file, consumed: result.consumed };
    },
    crateOf(file) {
      return moduleFor(file, [])?.crateRoot ?? null;
    },
    modulePath(file) {
      let module = modules.get(moduleKey(file, []));
      if (!module) return null;
      const names: string[] = [];
      while (module.parent !== null) {
        const parent: RustModule | undefined = modules.get(module.parent);
        if (!parent) break;
        const name = [...parent.children].find(([, key]) => key === module!.key)?.[0];
        if (name) names.unshift(name);
        module = parent;
      }
      return names;
    },
  };
}

function moduleKey(file: string, inline: string[]): string {
  return `${file}#${inline.join("::")}`;
}

// The directory `mod x;` looks in: a `mod.rs`, `lib.rs`, `main.rs` or crate
// root owns its directory; `foo.rs` owns `foo/`.
function moduleDirectory(file: string, isRoot: boolean): string {
  const dir = path.posix.dirname(file);
  if (isRoot || modFileNames.has(path.posix.basename(file))) return dir;
  return joinPath(dir, path.posix.basename(file, ".rs"));
}

function joinPath(dir: string, child: string): string {
  return path.posix.normalize(dir === "." ? child : path.posix.join(dir, child));
}
