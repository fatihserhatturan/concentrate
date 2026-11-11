import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseToml } from "../rust/cargo.js";

// The parts of a Python project's metadata the scan needs: its name, the
// directories its packages are imported from, its dependencies and the console
// scripts it installs. Read from `pyproject.toml` (PEP 621, Poetry,
// setuptools, hatch), `setup.cfg` and `setup.py` (a few well-known literals;
// `setup.py` is never executed).
export type PythonScript = {
  name: string;
  // `package.module:function`
  target: string;
};

export type PythonProject = {
  // Directory of the metadata file, relative to the scan root ("." for the root).
  dir: string;
  name: string | null;
  version: string | null;
  manager: string;
  // Directories (relative to the scan root) that hold top-level packages, in lookup order.
  sourceRoots: string[];
  dependencies: string[];
  scripts: PythonScript[];
  // Metadata files read, relative to the scan root.
  files: string[];
};

type Toml = Record<string, unknown>;

const metadataFiles = new Set(["pyproject.toml", "setup.cfg", "setup.py"]);

export async function readPythonProjects(rootPath: string, relativePaths: Iterable<string>): Promise<PythonProject[]> {
  const paths = [...relativePaths];
  const byDirectory = new Map<string, string[]>();
  for (const relativePath of paths) {
    const base = path.posix.basename(relativePath);
    if (!metadataFiles.has(base)) continue;
    const dir = path.posix.dirname(relativePath);
    byDirectory.set(dir, [...(byDirectory.get(dir) ?? []), base]);
  }

  const projects: PythonProject[] = [];
  for (const [dir, names] of [...byDirectory].sort(([a], [b]) => a.localeCompare(b))) {
    const project: PythonProject = { dir, name: null, version: null, manager: "pip", sourceRoots: [], dependencies: [], scripts: [], files: [] };
    let declared = false;
    // pyproject.toml first: it wins over setup.cfg, which wins over setup.py.
    for (const base of ["pyproject.toml", "setup.cfg", "setup.py"]) {
      if (!names.includes(base)) continue;
      let raw: string;
      try {
        raw = await readFile(path.join(rootPath, dir, base), "utf8");
      } catch {
        continue;
      }
      const read = base === "pyproject.toml" ? readPyproject(raw) : base === "setup.cfg" ? readSetupCfg(raw) : readSetupPy(raw);
      if (read === null) continue;
      declared = true;
      project.files.push(path.posix.join(dir, base));
      project.name ??= read.name;
      project.version ??= read.version;
      if (read.manager && (project.manager === "pip" || base === "pyproject.toml")) project.manager = read.manager;
      project.sourceRoots.push(...read.roots.map((root) => path.posix.normalize(path.posix.join(dir, root))));
      project.dependencies.push(...read.dependencies);
      for (const script of read.scripts) if (!project.scripts.some((existing) => existing.name === script.name)) project.scripts.push(script);
    }
    if (!declared) continue;

    const hasSource = (root: string) => paths.some((file) => file.startsWith(root === "." ? "" : `${root}/`) && file.endsWith(".py"));
    const conventional = path.posix.normalize(path.posix.join(dir, "src"));
    const roots = [...project.sourceRoots, ...(hasSource(conventional) ? [conventional] : []), dir];
    project.sourceRoots = [...new Set(roots)];
    project.dependencies = [...new Set(project.dependencies)];
    projects.push(project);
  }
  return projects;
}

type Read = { name: string | null; version: string | null; manager: string | null; roots: string[]; dependencies: string[]; scripts: PythonScript[] };

function readPyproject(raw: string): Read | null {
  const toml = parseToml(raw) as Toml;
  const project = table(toml.project);
  const tool = table(toml.tool);
  const poetry = table(tool.poetry);
  const setuptools = table(tool.setuptools);
  const backend = String(table(toml["build-system"])["build-backend"] ?? "");

  const roots: string[] = [];
  const packageDir = table(setuptools["package-dir"]);
  for (const value of Object.values(packageDir)) if (typeof value === "string") roots.push(value);
  const find = table(table(setuptools.packages).find);
  for (const where of strings(find.where)) roots.push(where);
  for (const entry of array(poetry.packages)) {
    const from = table(entry).from;
    if (typeof from === "string") roots.push(from);
  }
  const wheel = table(table(table(table(tool.hatch).build).targets).wheel);
  for (const entry of strings(wheel.packages)) {
    const slash = entry.lastIndexOf("/");
    if (slash > 0) roots.push(entry.slice(0, slash));
  }

  const dependencies = [
    ...strings(project.dependencies).map(requirementName),
    ...Object.values(table(project["optional-dependencies"])).flatMap((list) => strings(list).map(requirementName)),
    ...Object.keys(table(poetry.dependencies)).filter((name) => name.toLowerCase() !== "python"),
    ...Object.entries(table(poetry.group)).flatMap(([, group]) => Object.keys(table(table(group).dependencies))),
  ].filter((name) => name !== "");

  const scripts: PythonScript[] = [];
  for (const source of [table(project.scripts), table(project["gui-scripts"]), table(poetry.scripts)]) {
    for (const [name, value] of Object.entries(source)) {
      const target = typeof value === "string" ? value : typeof table(value).reference === "string" ? String(table(value).reference) : null;
      if (target) scripts.push({ name, target: target.trim() });
    }
  }

  const name = typeof project.name === "string" ? project.name : typeof poetry.name === "string" ? poetry.name : null;
  const version = typeof project.version === "string" ? project.version : typeof poetry.version === "string" ? poetry.version : null;
  const manager = Object.keys(poetry).length > 0 || backend.includes("poetry")
    ? "poetry"
    : backend.includes("hatch") ? "hatch"
      : backend.includes("flit") ? "flit"
        : backend.includes("pdm") ? "pdm"
          : backend.includes("maturin") ? "maturin"
            : backend.includes("setuptools") || Object.keys(setuptools).length > 0 ? "setuptools"
              : null;
  // A pyproject.toml that only configures tools (black, pytest) is not a project.
  if (name === null && Object.keys(project).length === 0 && Object.keys(poetry).length === 0 && manager === null && Object.keys(setuptools).length === 0) return null;
  return { name, version, manager, roots, dependencies, scripts };
}

function readSetupCfg(raw: string): Read | null {
  const sections = parseIni(raw);
  const metadata = sections.get("metadata") ?? new Map<string, string>();
  const options = sections.get("options") ?? new Map<string, string>();
  if (!sections.has("metadata") && !sections.has("options")) return null;

  const roots: string[] = [];
  for (const line of lines(options.get("package_dir"))) {
    const equals = line.indexOf("=");
    if (equals >= 0 && line.slice(0, equals).trim() === "") roots.push(line.slice(equals + 1).trim());
  }
  const where = sections.get("options.packages.find")?.get("where");
  for (const root of lines(where)) roots.push(root);

  const scripts: PythonScript[] = [];
  for (const line of lines(sections.get("options.entry_points")?.get("console_scripts"))) {
    const equals = line.indexOf("=");
    if (equals > 0) scripts.push({ name: line.slice(0, equals).trim(), target: line.slice(equals + 1).trim() });
  }
  return {
    name: metadata.get("name") ?? null,
    version: metadata.get("version") ?? null,
    manager: "setuptools",
    roots: roots.filter((root) => root !== ""),
    dependencies: lines(options.get("install_requires")).map(requirementName).filter((name) => name !== ""),
    scripts,
  };
}

// `setup(name="x", package_dir={"": "src"}, entry_points={"console_scripts": ["a = m:f"]})`
function readSetupPy(raw: string): Read | null {
  if (!/\bsetup\s*\(/u.test(raw)) return null;
  const name = /\bname\s*=\s*["']([^"']+)["']/u.exec(raw)?.[1] ?? null;
  const version = /\bversion\s*=\s*["']([^"']+)["']/u.exec(raw)?.[1] ?? null;
  const roots: string[] = [];
  const packageDir = /package_dir\s*=\s*\{([^}]*)\}/u.exec(raw)?.[1];
  if (packageDir) for (const match of packageDir.matchAll(/["']{2}\s*:\s*["']([^"']+)["']/gu)) roots.push(match[1]!);
  for (const match of raw.matchAll(/find(?:_namespace)?_packages\s*\([^)]*where\s*=\s*["']([^"']+)["']/gu)) roots.push(match[1]!);
  const scripts: PythonScript[] = [];
  const consoleScripts = /["']console_scripts["']\s*:\s*\[([^\]]*)\]/u.exec(raw)?.[1];
  if (consoleScripts) {
    for (const match of consoleScripts.matchAll(/["']\s*([\w.-]+)\s*=\s*([\w.]+:[\w.]+)[^"']*["']/gu)) scripts.push({ name: match[1]!, target: match[2]! });
  }
  const dependencies: string[] = [];
  const install = /install_requires\s*=\s*\[([^\]]*)\]/u.exec(raw)?.[1];
  if (install) for (const match of install.matchAll(/["']([^"']+)["']/gu)) dependencies.push(requirementName(match[1]!));
  return { name, version, manager: "setuptools", roots, dependencies: dependencies.filter((value) => value !== ""), scripts };
}

function parseIni(raw: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  let key: string | null = null;
  for (const rawLine of raw.split(/\r?\n/u)) {
    if (/^\s*[#;]/u.test(rawLine) || rawLine.trim() === "") continue;
    const header = /^\[([^\]]+)\]\s*$/u.exec(rawLine);
    if (header) {
      current = new Map();
      sections.set(header[1]!.trim(), current);
      key = null;
      continue;
    }
    if (!current) continue;
    // A continuation line is indented.
    if (/^\s/u.test(rawLine) && key !== null) {
      current.set(key, `${current.get(key) ?? ""}\n${rawLine.trim()}`);
      continue;
    }
    const match = /^([^=:]+?)\s*[=:]\s*(.*)$/u.exec(rawLine);
    if (!match) continue;
    key = match[1]!.trim();
    current.set(key, match[2]!.trim());
  }
  return sections;
}

function lines(value: string | undefined): string[] {
  return (value ?? "").split(/\n|,/u).map((line) => line.trim()).filter((line) => line !== "");
}

// `requests[security]>=2.0; python_version < "3.9"` -> `requests`
function requirementName(requirement: string): string {
  return /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/u.exec(requirement)?.[1] ?? "";
}

function table(value: unknown): Toml {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Toml : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).filter((entry): entry is string => typeof entry === "string");
}
