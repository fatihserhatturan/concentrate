import path from "node:path";
import type { PythonProject } from "./project.js";

// What the resolver needs of an `Import` node of a Python file.
export type PythonImportRecord = {
  importerFile: string;
  // `pkg.mod`, `.sibling`, `..parent.mod` or `.` (the package itself).
  source: string;
  // `name` of `from source import name`: a submodule or an attribute; null for `import a.b` and `from m import *`.
  importedName: string | null;
};

export type PythonImportResult = {
  // The file the import lands in (empty for a namespace package or a module outside the scan).
  files: string[];
  // True when the import names a module of the project that was not found.
  expected: boolean;
};

export type PythonResolver = {
  resolveImport(record: PythonImportRecord): PythonImportResult;
  // Directories that are importable top-level roots of the project of `file`, nearest first.
  rootsOf(file: string): string[];
  // Module path of a file, as `import` names it from its nearest root (`pkg.sub.mod`, `pkg` for `pkg/__init__.py`).
  moduleNameOf(file: string): string | null;
};

// Imports in Python follow `sys.path`, which a scan cannot know. The roots tried
// are the ones the project metadata declares (`src/` layout, `package-dir`,
// Poetry `packages`), the scan root, and the directory pytest or a script puts
// on the path (the first parent without an `__init__.py`).
export function createPythonResolver(projects: PythonProject[], files: ReadonlySet<string>): PythonResolver {
  const directories = new Set<string>();
  for (const file of files) {
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      directories.add(dir);
      if (dir === ".") break;
    }
  }

  const declaredRoots = [...new Set(projects.flatMap((project) => project.sourceRoots))];
  const rootCache = new Map<string, string[]>();
  const rootsOf = (file: string): string[] => {
    const dir = path.posix.dirname(file);
    let roots = rootCache.get(dir);
    if (roots) return roots;
    const own = projects
      .filter((project) => project.dir === "." || dir === project.dir || dir.startsWith(`${project.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)
      .flatMap((project) => project.sourceRoots);
    roots = [...new Set([basedirOf(dir, files), ...own, ...declaredRoots, "."])];
    rootCache.set(dir, roots);
    return roots;
  };

  const findModule = (root: string, segments: string[]): { file: string | null; directory: boolean } => {
    const base = path.posix.join(root, ...segments);
    if (segments.length === 0) {
      const init = path.posix.join(base, "__init__.py");
      return { file: files.has(init) ? init : null, directory: directories.has(base) };
    }
    for (const candidate of [`${base}.py`, path.posix.join(base, "__init__.py")]) if (files.has(candidate)) return { file: candidate, directory: false };
    return { file: null, directory: directories.has(base) };
  };

  const resolveAbsolute = (module: string, importer: string): { file: string | null; directory: boolean; local: boolean } => {
    const segments = module.split(".").filter((part) => part !== "");
    let namespace = false;
    let local = false;
    for (const root of rootsOf(importer)) {
      if (findModule(root, segments.slice(0, 1)).file || findModule(root, segments.slice(0, 1)).directory) local = true;
      const found = findModule(root, segments);
      if (found.file) return { file: found.file, directory: false, local: true };
      if (found.directory) namespace = true;
    }
    return { file: null, directory: namespace, local };
  };

  const resolveRelative = (source: string, importer: string, importedName: string | null): PythonImportResult => {
    const level = /^\.+/u.exec(source)?.[0].length ?? 0;
    const rest = source.slice(level).split(".").filter((part) => part !== "");
    let base = path.posix.dirname(importer);
    for (let up = 1; up < level; up += 1) base = path.posix.dirname(base);
    if (base === "." && level > 1 && path.posix.dirname(importer) === ".") return { files: [], expected: true };

    if (importedName) {
      const submodule = findModule(base, [...rest, importedName]);
      if (submodule.file) return { files: [submodule.file], expected: false };
      if (submodule.directory) return { files: [], expected: false };
    }
    const module = findModule(base, rest);
    if (module.file) return { files: [module.file], expected: false };
    return { files: [], expected: !module.directory };
  };

  const resolveImport = (record: PythonImportRecord): PythonImportResult => {
    if (record.source.startsWith(".")) return resolveRelative(record.source, record.importerFile, record.importedName);

    if (record.importedName) {
      const submodule = resolveAbsolute(`${record.source}.${record.importedName}`, record.importerFile);
      if (submodule.file) return { files: [submodule.file], expected: false };
      if (submodule.directory) return { files: [], expected: false };
    }
    const module = resolveAbsolute(record.source, record.importerFile);
    if (module.file) return { files: [module.file], expected: false };
    // `import os`, `import requests`: not part of the scan, not a miss.
    return { files: [], expected: module.local && !module.directory };
  };

  const moduleCache = new Map<string, string | null>();
  const moduleNameOf = (file: string): string | null => {
    if (moduleCache.has(file)) return moduleCache.get(file)!;
    let best: string | null = null;
    for (const root of rootsOf(file)) {
      const relative = root === "." ? file : file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
      if (relative === null) continue;
      const withoutExtension = relative.replace(/\.py$/u, "");
      const name = withoutExtension.endsWith("/__init__") ? withoutExtension.slice(0, -"/__init__".length) : withoutExtension === "__init__" ? "" : withoutExtension;
      if (name === "") continue;
      const dotted = name.split("/").join(".");
      if (best === null || dotted.length < best.length) best = dotted;
    }
    moduleCache.set(file, best);
    return best;
  };

  return { resolveImport, rootsOf, moduleNameOf };
}

// The directory pytest (`rootdir`/`prepend` mode) or `python script.py` puts on
// `sys.path`: the first directory upward without an `__init__.py`.
function basedirOf(dir: string, files: ReadonlySet<string>): string {
  let current = dir;
  while (current !== "." && files.has(path.posix.join(current, "__init__.py"))) current = path.posix.dirname(current);
  return current;
}
