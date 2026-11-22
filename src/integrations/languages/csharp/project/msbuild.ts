import path from "node:path";
import { childElements, readXml, type XmlElement } from "../../syntax/xml.js";
import { implicitUsingsOfSdk, type CSharpPackageReference, type CSharpProject, type CSharpUsing } from "./types.js";

export type MsbuildInput = {
  /** Every scanned file (scan-relative posix paths): used to resolve ProjectReference targets and to find the props files above a project. */
  files: Set<string>;
  /** Text of each `.csproj` and each `Directory.Build.props` / `Directory.Packages.props` (and other `.props`) file, by path. */
  texts: Map<string, string>;
};

export type MsbuildResult = {
  projects: CSharpProject[];
  /** The project and props files that were interpreted. */
  files: string[];
  unresolved: number;
};

// `.csproj` / `Directory.Build.props` / `Directory.Packages.props` interpreter. `solutions` of each project is left empty here;
// `readCSharpProjectModel` fills it from the solutions.
//
// Evaluation (per project): the nearest `Directory.Build.props` (which chains to its parent only through an explicit
// `GetPathOfFileAbove` Import), then the project file, in document order; later property definitions win. `Condition`
// attributes are ignored (every element is taken) except the "default if empty" pattern `'$(X)' == ''` on a property `X`.
// `Directory.Packages.props` (nearest) only supplies `PackageVersion` items.

const CONFIG_KEYS = [
  "TargetFramework",
  "TargetFrameworks",
  "OutputType",
  "RootNamespace",
  "AssemblyName",
  "LangVersion",
  "Nullable",
  "ImplicitUsings",
  "AllowUnsafeBlocks",
  "TreatWarningsAsErrors",
  "Version",
];
const TEST_PACKAGES = new Set(["microsoft.net.test.sdk", "xunit", "nunit", "mstest.testframework"]);
// Imports from the build toolchain (not from the repository): not counted when their location is an unknown property.
const TOOLCHAIN_PROPS = /\$\((MSBuildToolsPath|MSBuildBinPath|MSBuildExtensionsPath\w*|MSBuildSDKsPath|VSToolsPath|MSBuildToolsVersion)\)/iu;
const FILE_ABOVE = /^\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*([^,]+?)\s*(?:,\s*(.*?)\s*)?\)\)$/iu;
const unquote = (value: string | undefined): string | undefined => (value === undefined ? undefined : value.replace(/^\s*['"]/u, "").replace(/['"]\s*$/u, ""));

type UsingOp = { kind: "include"; using: CSharpUsing } | { kind: "remove"; namespace: string };
type PackageOp = { name: string; version: string | null; override: string | null };

type Context = {
  /** lower-case name -> value */
  props: Map<string, string>;
  usingOps: UsingOp[];
  projectRefs: string[];
  packages: Map<string, PackageOp>;
  versions: Map<string, string>;
  applied: string[];
  chain: Set<string>;
  unresolved: number;
  project: { name: string; file: string; dir: string; sdk: string | null };
};

function dirOf(file: string): string {
  const dir = path.posix.dirname(file);
  return dir === "" ? "." : dir;
}

function join(dir: string, rel: string): string | null {
  const normalized = path.posix.normalize(dir === "." ? rel : `${dir}/${rel}`).replace(/\/$/u, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return null;
  return normalized === "" ? "." : normalized.replace(/^\.\//u, "");
}

function attr(element: XmlElement, name: string): string | undefined {
  if (element.attributes[name] !== undefined) return element.attributes[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(element.attributes)) if (key.toLowerCase() === lower) return element.attributes[key];
  return undefined;
}

function childValue(element: XmlElement, name: string): string | undefined {
  const lower = name.toLowerCase();
  const child = element.children.find((candidate) => candidate.name.toLowerCase() === lower);
  return child ? child.text.trim() : undefined;
}

function truthy(value: string | undefined): boolean {
  const lower = value?.trim().toLowerCase();
  return lower === "true" || lower === "enable";
}

// Directory built-ins expand to absolute-looking paths under a virtual root, so they compose with relative paths like real
// MSBuild's absolute ones; `resolvePath` maps them back to scan-relative paths.
const VIRTUAL_ROOT = "/__root__";
function virtual(relative: string): string {
  return relative === "." ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${relative}`;
}

function resolvePath(baseDir: string, text: string): string | null {
  const posix = text.replace(/\\/gu, "/");
  if (posix === VIRTUAL_ROOT || posix.startsWith(`${VIRTUAL_ROOT}/`)) return join(".", posix.slice(VIRTUAL_ROOT.length).replace(/^\//u, "") || ".");
  return join(baseDir, posix);
}

function builtin(name: string, context: Context, thisFile: string): string | undefined {
  const { project } = context;
  switch (name.toLowerCase()) {
    case "msbuildprojectname":
      return project.name;
    case "msbuildprojectdirectory":
      return virtual(project.dir);
    case "msbuildprojectfile":
      return path.posix.basename(project.file);
    case "msbuildprojectfullpath":
      return virtual(project.file);
    case "msbuildprojectextension":
      return ".csproj";
    case "msbuildthisfile":
      return path.posix.basename(thisFile);
    case "msbuildthisfilename":
      return path.posix.basename(thisFile).replace(/\.[^.]*$/u, "");
    case "msbuildthisfiledirectory": {
      return `${virtual(dirOf(thisFile))}/`;
    }
    default:
      return undefined;
  }
}

/** Expand `$(Name)`; an unknown property or a property function counts as unresolved and expands to "". `self` (the property being defined) is never counted. */
function expand(value: string, context: Context, thisFile: string, self: string | null = null, quiet = false): { text: string; unknown: number } {
  if (!value.includes("$(")) return { text: value, unknown: 0 };
  let out = "";
  let unknown = 0;
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("$(", index);
    if (start === -1) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, start);
    let depth = 1;
    let end = start + 2;
    while (end < value.length && depth > 0) {
      const ch = value[end];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      end += 1;
    }
    if (depth > 0) {
      unknown += 1;
      break;
    }
    const inner = value.slice(start + 2, end - 1).trim();
    index = end;
    if (/^[A-Za-z_][\w-]*$/u.test(inner)) {
      const known = builtin(inner, context, thisFile) ?? context.props.get(inner.toLowerCase());
      if (known !== undefined) out += known;
      else if (self === null || inner.toLowerCase() !== self.toLowerCase()) unknown += 1;
    } else unknown += 1;
  }
  if (!quiet) context.unresolved += unknown;
  return { text: out, unknown };
}

function splitList(value: string): string[] {
  return value.split(";").map((part) => part.trim()).filter((part) => part !== "");
}

function sdkName(value: string): string {
  return (splitList(value)[0] ?? "").split("/")[0]!.trim();
}

// `'$(X)' == ''` on a property X: the "default" pattern, which only applies when X has no value yet.
function isDefaultIfEmpty(condition: string | undefined, name: string): boolean {
  if (condition === undefined) return false;
  const match = /^\s*'\$\(([^)]+)\)'\s*==\s*''\s*$|^\s*''\s*==\s*'\$\(([^)]+)\)'\s*$/u.exec(condition);
  const target = match?.[1] ?? match?.[2];
  return target !== undefined && target.toLowerCase() === name.toLowerCase();
}

type Locator = {
  files: Set<string>;
  texts: Map<string, string>;
  parsed: Map<string, { root: XmlElement | null; wellFormed: boolean }>;
  nearest: Map<string, string | null>;
};

function parseFile(locator: Locator, file: string): { root: XmlElement | null; wellFormed: boolean } {
  let entry = locator.parsed.get(file);
  if (!entry) {
    const read = readXml(locator.texts.get(file) ?? "");
    const root = read.root.name === "Project" ? read.root : (read.root.children.find((child) => child.name === "Project") ?? null);
    entry = { root, wellFormed: read.wellFormed && root !== null };
    locator.parsed.set(file, entry);
  }
  return entry;
}

/** The nearest `name` in `startDir` or above (scan-relative dirs), among the files whose text was read. Memoized per directory. */
function fileAbove(locator: Locator, name: string, startDir: string): string | null {
  const walked: string[] = [];
  let found: string | null = null;
  let dir = startDir;
  for (;;) {
    const cacheKey = `${dir}\0${name}`;
    if (locator.nearest.has(cacheKey)) {
      found = locator.nearest.get(cacheKey) ?? null;
      break;
    }
    walked.push(cacheKey);
    const candidate = dir === "." ? name : `${dir}/${name}`;
    if (locator.texts.has(candidate)) {
      found = candidate;
      break;
    }
    if (dir === ".") break;
    dir = dirOf(dir);
  }
  for (const cacheKey of walked) locator.nearest.set(cacheKey, found);
  return found;
}

function evaluateFile(locator: Locator, context: Context, file: string, isProject: boolean): void {
  if (context.chain.has(file)) return;
  context.chain.add(file);
  const parsed = parseFile(locator, file);
  if (!isProject && !context.applied.includes(file)) context.applied.push(file);
  if (!parsed.wellFormed) context.unresolved += 1;
  if (parsed.root) {
    for (const element of parsed.root.children) {
      switch (element.name) {
        case "PropertyGroup":
          for (const property of element.children) defineProperty(context, file, property);
          break;
        case "ItemGroup":
          for (const item of element.children) applyItem(locator, context, file, item);
          break;
        case "Import":
          applyImport(locator, context, file, element);
          break;
        default:
          break;
      }
    }
  }
  context.chain.delete(file);
}

function defineProperty(context: Context, file: string, element: XmlElement): void {
  const key = element.name.toLowerCase();
  if (isDefaultIfEmpty(attr(element, "Condition"), element.name) && (context.props.get(key) ?? "") !== "") return;
  const value = expand(element.text.trim(), context, file, element.name).text.trim();
  context.props.set(key, value);
}

function applyItem(locator: Locator, context: Context, file: string, item: XmlElement): void {
  const kind = item.name.toLowerCase();
  const project = context.project;
  const expandAttr = (name: string): string | undefined => {
    const raw = attr(item, name);
    return raw === undefined ? undefined : expand(raw, context, file).text.trim();
  };
  if (kind === "using") {
    const include = expandAttr("Include");
    const remove = expandAttr("Remove");
    if (include !== undefined) {
      const isStatic = truthy(expandAttr("Static"));
      const alias = expandAttr("Alias") || null;
      for (const namespace of splitList(include)) context.usingOps.push({ kind: "include", using: { namespace, static: isStatic, alias } });
    }
    if (remove !== undefined) for (const namespace of splitList(remove)) context.usingOps.push({ kind: "remove", namespace });
  } else if (kind === "projectreference") {
    const include = expandAttr("Include");
    const remove = expandAttr("Remove");
    if (include !== undefined) {
      for (const raw of splitList(include)) {
        if (raw.includes("*")) continue;
        const target = resolvePath(project.dir, raw);
        if (target === null || !locator.files.has(target)) {
          context.unresolved += 1;
        } else if (target.endsWith(".csproj") && !context.projectRefs.includes(target)) {
          context.projectRefs.push(target);
        }
      }
    }
    if (remove !== undefined) {
      for (const raw of splitList(remove)) {
        const target = resolvePath(project.dir, raw);
        const at = target === null ? -1 : context.projectRefs.indexOf(target);
        if (at >= 0) context.projectRefs.splice(at, 1);
      }
    }
  } else if (kind === "packagereference") {
    const include = expandAttr("Include");
    const update = expandAttr("Update");
    const remove = expandAttr("Remove");
    const versionRaw = attr(item, "Version") ?? childValue(item, "Version");
    const version = versionRaw === undefined ? null : expand(versionRaw, context, file).text.trim() || null;
    const overrideRaw = attr(item, "VersionOverride") ?? childValue(item, "VersionOverride");
    const override = overrideRaw === undefined ? null : expand(overrideRaw, context, file).text.trim() || null;
    for (const name of splitList(include ?? "")) {
      const key = name.toLowerCase();
      const existing = context.packages.get(key);
      if (existing) {
        existing.version = version ?? existing.version;
        existing.override = override ?? existing.override;
      } else context.packages.set(key, { name, version, override });
    }
    for (const name of splitList(update ?? "")) {
      const existing = context.packages.get(name.toLowerCase());
      if (existing) {
        existing.version = version ?? existing.version;
        existing.override = override ?? existing.override;
      }
    }
    for (const name of splitList(remove ?? "")) context.packages.delete(name.toLowerCase());
  } else if (kind === "packageversion") {
    const versionRaw = attr(item, "Version") ?? childValue(item, "Version");
    if (versionRaw === undefined) return;
    const version = expand(versionRaw, context, file).text.trim();
    if (version === "") return;
    for (const name of splitList(expandAttr("Include") ?? expandAttr("Update") ?? "")) context.versions.set(name.toLowerCase(), version);
  }
}

function applyImport(locator: Locator, context: Context, file: string, element: XmlElement): void {
  const raw = attr(element, "Project");
  if (raw === undefined) return;
  const sdk = attr(element, "Sdk");
  if (sdk !== undefined) {
    if (context.chain.size === 1 && context.project.sdk === null && /^sdk\.props$/iu.test(raw.trim())) context.project.sdk = sdkName(sdk) || null;
    return;
  }
  const condition = attr(element, "Condition");
  const optional = condition !== undefined && /exists\s*\(/iu.test(condition);
  const dir = dirOf(file);
  let target: string | null = null;
  const above = FILE_ABOVE.exec(raw.trim());
  if (above) {
    const name = expand(unquote(above[1])!, context, file, null, true).text;
    const startRaw = unquote(above[2]);
    const start = startRaw === undefined || startRaw === "" ? dir : resolvePath(".", expand(startRaw, context, file, null, true).text);
    if (start !== null) {
      const found = fileAbove(locator, name, start);
      if (found !== null && found !== file) target = found;
    }
  } else {
    const expanded = expand(raw, context, file, null, true);
    if (expanded.unknown === 0) {
      const resolved = resolvePath(dir, expanded.text);
      if (resolved !== null && locator.files.has(resolved)) {
        if (locator.texts.has(resolved)) target = resolved;
        else return; // scanned but not interpreted (a .targets file, an unreadable file)
      }
    } else if (TOOLCHAIN_PROPS.test(raw)) return;
  }
  if (target === null) {
    if (!optional) context.unresolved += 1;
    return;
  }
  evaluateFile(locator, context, target, false);
}

function newContext(project: Context["project"]): Context {
  return {
    props: new Map(),
    usingOps: [],
    projectRefs: [],
    packages: new Map(),
    versions: new Map(),
    applied: [],
    chain: new Set(),
    unresolved: 0,
    project,
  };
}

function effectiveUsings(sdk: string | null, enabled: boolean, ops: UsingOp[]): CSharpUsing[] {
  let usings: CSharpUsing[] = enabled ? implicitUsingsOfSdk(sdk).map((namespace) => ({ namespace, static: false, alias: null })) : [];
  for (const op of ops) {
    if (op.kind === "remove") usings = usings.filter((using) => using.namespace !== op.namespace);
    else if (!usings.some((using) => using.namespace === op.using.namespace && using.static === op.using.static && using.alias === op.using.alias)) usings.push(op.using);
  }
  return usings;
}

function interpretProject(locator: Locator, file: string): { project: CSharpProject; applied: string[] } {
  const parsed = parseFile(locator, file);
  const name = path.posix.basename(file).replace(/\.csproj$/u, "");
  const dir = dirOf(file);
  let sdk: string | null = null;
  if (parsed.root) {
    const sdkAttr = attr(parsed.root, "Sdk");
    if (sdkAttr !== undefined && sdkName(sdkAttr) !== "") sdk = sdkName(sdkAttr);
    else {
      const sdkElement = childElements(parsed.root, "Sdk")[0];
      const sdkValue = sdkElement ? attr(sdkElement, "Name") : undefined;
      if (sdkValue !== undefined && sdkName(sdkValue) !== "") sdk = sdkName(sdkValue);
    }
  }
  const context = newContext({ name, file, dir, sdk });

  const buildProps = fileAbove(locator, "Directory.Build.props", dir);
  if (buildProps !== null && buildProps !== file) evaluateFile(locator, context, buildProps, false);
  evaluateFile(locator, context, file, true);

  const packagesProps = fileAbove(locator, "Directory.Packages.props", dir);
  if (packagesProps !== null) {
    const central = newContext(context.project);
    evaluateFile(locator, central, packagesProps, false);
    context.unresolved += central.unresolved;
    for (const applied of central.applied) if (!context.applied.includes(applied)) context.applied.push(applied);
    for (const [key, version] of central.versions) context.versions.set(key, version);
  }

  const get = (key: string): string | undefined => context.props.get(key.toLowerCase());
  const finalSdk = context.project.sdk;
  const packageReferences: CSharpPackageReference[] = [...context.packages.values()].map((entry) => ({
    name: entry.name,
    version: entry.override ?? entry.version ?? context.versions.get(entry.name.toLowerCase()) ?? null,
  }));
  const webLike = finalSdk === "Microsoft.NET.Sdk.Web" || finalSdk === "Microsoft.NET.Sdk.Worker";
  const outputType = get("OutputType") || (webLike ? "Exe" : "Library");
  const outputLower = outputType.toLowerCase();
  const frameworks = splitList(get("TargetFrameworks") ?? "");
  const targetFrameworks = frameworks.length > 0 ? frameworks : splitList(get("TargetFramework") || get("TargetFrameworkVersion") || "");
  const implicitUsings = truthy(get("ImplicitUsings"));

  const config: Array<{ key: string; value: string }> = [];
  if (finalSdk !== null) config.push({ key: "Sdk", value: finalSdk });
  for (const key of CONFIG_KEYS) {
    const value = get(key);
    if (value !== undefined && value !== "") config.push({ key, value });
  }

  const project: CSharpProject = {
    name,
    file,
    dir,
    sdk: finalSdk,
    outputType,
    executable: outputLower === "exe" || outputLower === "winexe" || (webLike && outputLower !== "library"),
    rootNamespace: get("RootNamespace") || name,
    assemblyName: get("AssemblyName") || name,
    targetFrameworks,
    implicitUsings,
    usings: effectiveUsings(finalSdk, implicitUsings, context.usingOps),
    projectReferences: [...context.projectRefs].sort(),
    packageReferences,
    isTestProject: get("IsTestProject")?.toLowerCase() === "true" || packageReferences.some((pkg) => TEST_PACKAGES.has(pkg.name.toLowerCase())),
    importedProps: context.applied,
    solutions: [],
    config,
    unresolved: context.unresolved,
    line: 1,
  };
  return { project, applied: context.applied };
}

export function interpretMsbuild(input: MsbuildInput): MsbuildResult {
  const locator: Locator = { files: input.files, texts: input.texts, parsed: new Map(), nearest: new Map() };
  const projectFiles = [...input.texts.keys()].filter((file) => file.endsWith(".csproj")).sort();
  const projects: CSharpProject[] = [];
  const read = new Set<string>();
  let unresolved = 0;
  for (const file of projectFiles) {
    const { project, applied } = interpretProject(locator, file);
    projects.push(project);
    read.add(file);
    for (const props of applied) read.add(props);
    unresolved += project.unresolved;
  }
  return { projects, files: [...read].sort(), unresolved };
}
