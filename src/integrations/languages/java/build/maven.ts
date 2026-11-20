import path from "node:path";
import { childElement, childElements, childText, descend, readXml, type XmlElement } from "./xml.js";
import { javaModuleKey, type JavaBuildModel, type JavaModule } from "./types.js";

// Interprets the `pom.xml` files of a Maven project: the module (`groupId:artifactId`, version,
// packaging), the `<modules>` of an aggregator, the `<parent>` chain, `<properties>`,
// `<dependencies>` on other modules of the scan, the source directories of `<build>` and the main
// class a plugin declares (`spring-boot-maven-plugin`, `exec-maven-plugin`, `maven-jar-plugin`).
//
// `groupId` and `version` are inherited from `<parent>` when a pom has none. The parent is the
// scanned pom at `<relativePath>` (default `../pom.xml`) when its coordinates match, else any
// scanned pom with the declared coordinates. Properties are inherited down that chain.
//
// `${name}` is expanded from the properties (own first, then the parents'), `project.version`,
// `project.groupId`, `project.artifactId`, `project.basedir` (and `basedir`),
// `project.parent.{groupId,artifactId,version}` and the `pom.` aliases. A reference that is
// unknown or recursive is left as written and counted in `unresolved`.
//
// Honest limits: profiles, `<dependencyManagement>`, plugin inheritance and the repository
// (an artifact that is not a scanned module) are not read. `<dependencies>` are inherited from the
// parent chain; `<sourceDirectory>` and the plugins are read from the module's own pom only. Source roots are always reported, whether or not the
// directory exists.

export type MavenInput = {
  // Every scanned file, relative to the root.
  files: ReadonlySet<string>;
  // Source text of the `pom.xml` files, by relative path.
  texts: ReadonlyMap<string, string>;
};

type Pom = {
  file: string;
  dir: string;
  root: XmlElement;
  props: Map<string, string>;
  parent: Pom | null;
  // Expanded `${name}` values of this pom, with the unresolved references counted while expanding.
  memo: Map<string, { value: string | null; n: number }>;
};

type Counter = { n: number };

// A property whose expansion is longer than this is left unexpanded (`p1=${p0}${p0}`, ...).
const MAX_EXPANDED_LENGTH = 10_000;
// Set when an expansion met a cycle: its outcome depends on the call stack and is not memoized.
let stackDependent = 0;

const MAX_DEPTH = 32;
const CONFIG_PROPERTIES = ["maven.compiler.release", "maven.compiler.source", "maven.compiler.target", "java.version"];

export function interpretMaven(input: MavenInput): JavaBuildModel {
  const poms = new Map<string, Pom>();
  for (const file of [...input.texts.keys()].sort()) {
    const text = input.texts.get(file) ?? "";
    const root = safeRead(text);
    if (!root) continue;
    const dir = path.posix.dirname(file);
    poms.set(file, { file, dir, root, props: readProperties(root), parent: null, memo: new Map() });
  }

  // Parents: by `<relativePath>` first, then by coordinates among the scanned poms.
  const byCoordinates = new Map<string, Pom>();
  for (const pom of poms.values()) {
    const key = coordinates(pom, { n: 0 });
    if (key && !byCoordinates.has(key)) byCoordinates.set(key, pom);
  }
  for (const pom of poms.values()) pom.parent = findParent(pom, poms, byCoordinates);
  breakParentCycles(poms);

  const modules: JavaModule[] = [];
  const keyOf = new Map<Pom, string>();
  const seen = new Set<string>();
  const byKey = new Map<string, Pom>();
  for (const pom of poms.values()) {
    const key = coordinates(pom, { n: 0 });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keyOf.set(pom, key);
    byKey.set(key, pom);
  }

  for (const [pom, key] of keyOf) modules.push(buildModule(pom, key, input.files, keyOf, byKey));
  modules.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return {
    modules,
    files: [...poms.keys()].sort(),
    unresolved: modules.reduce((sum, module) => sum + module.unresolved, 0),
  };
}

function safeRead(text: string): XmlElement | null {
  try {
    const { root } = readXml(text);
    return root.name === "project" ? root : (childElement(root, "project") ?? null);
  } catch {
    return null;
  }
}

function readProperties(root: XmlElement): Map<string, string> {
  const props = new Map<string, string>();
  for (const child of descend(root, "properties")?.children ?? []) {
    if (!props.has(child.name)) props.set(child.name, child.text.trim());
  }
  return props;
}

function rawGroupId(pom: Pom): string | null {
  return childText(pom.root, "groupId") ?? childText(childElement(pom.root, "parent"), "groupId");
}

function rawVersion(pom: Pom): string | null {
  return childText(pom.root, "version") ?? childText(childElement(pom.root, "parent"), "version");
}

function coordinates(pom: Pom, counter: Counter): string | null {
  const artifactId = childText(pom.root, "artifactId");
  if (!artifactId) return null;
  const groupId = rawGroupId(pom);
  const artifact = expand(pom, artifactId, [], counter);
  if (!groupId) return artifact;
  return `${expand(pom, groupId, [], counter)}:${artifact}`;
}

function findParent(pom: Pom, poms: Map<string, Pom>, byCoordinates: Map<string, Pom>): Pom | null {
  const declared = childElement(pom.root, "parent");
  if (!declared) return null;
  const groupId = childText(declared, "groupId");
  const artifactId = childText(declared, "artifactId");
  const wanted = groupId && artifactId ? `${groupId}:${artifactId}` : null;
  const relative = childElement(declared, "relativePath");
  // An empty `<relativePath/>` says the parent is not in the tree.
  if (!relative || relative.text.trim() !== "") {
    const raw = relative ? relative.text.trim() : "../pom.xml";
    const target = path.posix.normalize(path.posix.join(pom.dir, raw));
    const candidates = target.endsWith(".xml") ? [target] : [path.posix.join(target, "pom.xml")];
    for (const candidate of candidates) {
      const found = poms.get(candidate);
      if (found && found !== pom && (!wanted || coordinates(found, { n: 0 }) === wanted)) return found;
    }
  }
  if (!wanted) return null;
  const found = byCoordinates.get(wanted);
  return found && found !== pom ? found : null;
}

function breakParentCycles(poms: Map<string, Pom>): void {
  for (const pom of poms.values()) {
    const chain = new Set<Pom>([pom]);
    let current: Pom = pom;
    while (current.parent) {
      if (chain.has(current.parent)) {
        current.parent = null;
        break;
      }
      chain.add(current.parent);
      current = current.parent;
    }
  }
}

// Property lookup through the parent chain; the raw (unexpanded) value.
function lookupProperty(pom: Pom, name: string): string | null {
  for (let current: Pom | null = pom; current; current = current.parent) {
    const value = current.props.get(name);
    if (value !== undefined) return value;
  }
  return null;
}

function expand(pom: Pom, text: string, stack: string[], counter: Counter): string {
  if (!text.includes("${")) return text;
  return text.replace(/\$\{([^}]*)\}/gu, (whole, rawName: string) => {
    const name = rawName.trim();
    const value = resolveName(pom, name, stack, counter);
    if (value === null) {
      counter.n += 1;
      return whole;
    }
    return value;
  });
}

function resolveName(pom: Pom, name: string, stack: string[], counter: Counter): string | null {
  if (stack.includes(name)) {
    stackDependent += 1;
    return null;
  }
  // Past the depth limit the value is unknown; memoized like any other, so a long chain stays linear.
  if (stack.length >= MAX_DEPTH) return null;
  const memo = pom.memo.get(name);
  if (memo) {
    counter.n += memo.n;
    return memo.value;
  }
  const before = counter.n;
  const taint = stackDependent;
  let value = resolveUncached(pom, name, stack, counter);
  if (value !== null && value.length > MAX_EXPANDED_LENGTH) value = null;
  if (stackDependent === taint) pom.memo.set(name, { value, n: Math.min(counter.n - before, 1000) });
  return value;
}

function resolveUncached(pom: Pom, name: string, stack: string[], counter: Counter): string | null {
  const next = [...stack, name];
  const declared = childElement(pom.root, "parent");
  const from = (raw: string | null): string | null => (raw === null ? null : expand(pom, raw, next, counter));
  const key = name.startsWith("pom.") ? `project.${name.slice(4)}` : name;
  switch (key) {
    case "project.version":
      return from(rawVersion(pom));
    case "project.groupId":
      return from(rawGroupId(pom));
    case "project.artifactId":
      return from(childText(pom.root, "artifactId"));
    case "project.basedir":
    case "basedir":
      return ".";
    case "project.parent.version":
      return from(childText(declared, "version"));
    case "project.parent.groupId":
      return from(childText(declared, "groupId"));
    case "project.parent.artifactId":
      return from(childText(declared, "artifactId"));
    default:
      return from(lookupProperty(pom, name));
  }
}

function buildModule(
  pom: Pom,
  key: string,
  files: ReadonlySet<string>,
  keyOf: Map<Pom, string>,
  byKey: Map<string, Pom>,
): JavaModule {
  const counter: Counter = { n: 0 };
  const artifactElement = childElement(pom.root, "artifactId");
  const versionRaw = rawVersion(pom);
  const version = versionRaw ? expand(pom, versionRaw, [], counter) : null;
  const packaging = expand(pom, childText(pom.root, "packaging") ?? "jar", [], counter);

  // <modules>
  for (const module of childElements(childElement(pom.root, "modules"), "module")) {
    const raw = module.text.trim();
    if (raw === "") continue;
    const value = expand(pom, raw, [], counter);
    const target = path.posix.normalize(path.posix.join(pom.dir, value));
    const pomFile = target.endsWith(".xml") ? target : path.posix.join(target, "pom.xml");
    if (!files.has(pomFile)) counter.n += 1;
  }

  // <dependencies> on other modules of the scan (not <dependencyManagement>). Maven inherits them
  // down the parent chain: a declaration of the module wins over an inherited one of the same
  // artifact, and the scope comes from the nearest declaration.
  const dependencies: JavaModule["dependencies"] = [];
  const dependencySeen = new Set<string>();
  const declaredAt = new Map<string, Pom>();
  for (let level: Pom | null = pom; level; level = level.parent) {
    for (const dependency of childElements(childElement(level.root, "dependencies"), "dependency")) {
      const groupId = childText(dependency, "groupId");
      const artifactId = childText(dependency, "artifactId");
      if (!groupId || !artifactId) continue;
      // Counted only when the unknown reference stands in a coordinate: an external artifact
      // with a version property the scan does not know is not ours to report.
      const local: Counter = { n: 0 };
      const target = `${expand(pom, groupId, [], local)}:${expand(pom, artifactId, [], local)}`;
      counter.n += local.n;
      if (!byKey.has(target) || target === key) continue;
      const nearest = declaredAt.get(target);
      if (nearest !== undefined && nearest !== level) continue;
      declaredAt.set(target, level);
      const scope = expand(pom, childText(dependency, "scope") ?? "compile", [], counter);
      const id = `${target}\0${scope}`;
      if (dependencySeen.has(id)) continue;
      dependencySeen.add(id);
      dependencies.push({ module: javaModuleKey({ system: "maven", name: target }), scope });
    }
  }

  // <build> source directories.
  const build = childElement(pom.root, "build");
  const sourceRoots = [moduleRoot(pom, childText(build, "sourceDirectory"), "src/main/java", counter)];
  const testSourceRoots = [moduleRoot(pom, childText(build, "testSourceDirectory"), "src/test/java", counter)];

  const main = findMainClass(pom, counter);

  const config: JavaModule["config"] = [];
  for (const name of CONFIG_PROPERTIES) {
    const raw = lookupProperty(pom, name);
    if (raw !== null && raw !== "") config.push({ key: name, value: expand(pom, raw, [name], counter) });
  }
  config.push({ key: "packaging", value: packaging });

  return {
    system: "maven",
    name: key,
    dir: pom.dir,
    file: pom.file,
    line: (artifactElement ?? pom.root).line,
    version,
    aggregator: packaging === "pom",
    parent: pom.parent ? (keyOf.has(pom.parent) ? javaModuleKey({ system: "maven", name: keyOf.get(pom.parent)! }) : null) : null,
    sourceRoots,
    testSourceRoots,
    dependencies,
    mainClass: main?.value ?? null,
    mainClassSource: main?.source ?? null,
    config,
    unresolved: counter.n,
  };
}

// A source directory of the module, relative to the scan root. Absolute paths and paths that
// leave the scan root are unusable: the conventional directory is kept and the value counted.
function moduleRoot(pom: Pom, raw: string | null, conventional: string, counter: Counter): string {
  if (raw === null) return path.posix.normalize(path.posix.join(pom.dir, conventional));
  const before = counter.n;
  const value = expand(pom, raw, [], counter).replace(/\\/gu, "/");
  // Still holding a `${...}`: the directory is unknown, the conventional one stays.
  if (counter.n > before) return path.posix.normalize(path.posix.join(pom.dir, conventional));
  const joined = path.posix.normalize(path.posix.join(pom.dir, value));
  if (path.posix.isAbsolute(value) || joined === ".." || joined.startsWith("../")) {
    counter.n += 1;
    return path.posix.normalize(path.posix.join(pom.dir, conventional));
  }
  return joined;
}

function pluginsOf(pom: Pom): XmlElement[] {
  const build = childElement(pom.root, "build");
  return [
    ...childElements(childElement(build, "plugins"), "plugin"),
    ...childElements(descend(build, "pluginManagement", "plugins"), "plugin"),
  ];
}

// The configuration blocks of a plugin: its own and those of its executions.
function configurations(plugin: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const own = childElement(plugin, "configuration");
  if (own) result.push(own);
  for (const execution of childElements(childElement(plugin, "executions"), "execution")) {
    const config = childElement(execution, "configuration");
    if (config) result.push(config);
  }
  return result;
}

function findMainClass(pom: Pom, counter: Counter): { value: string; source: string } | null {
  const plugins = pluginsOf(pom);
  const pick = (artifactId: string, select: (config: XmlElement) => string | null): string | null => {
    for (const plugin of plugins) {
      if (childText(plugin, "artifactId") !== artifactId) continue;
      for (const config of configurations(plugin)) {
        const raw = select(config);
        if (raw) return raw;
      }
    }
    return null;
  };
  const candidates: Array<[string, string | null]> = [
    ["spring-boot-maven-plugin", pick("spring-boot-maven-plugin", (config) => childText(config, "mainClass"))],
    ["spring-boot-maven-plugin", lookupProperty(pom, "start-class") || null],
    ["exec-maven-plugin", pick("exec-maven-plugin", (config) => childText(config, "mainClass"))],
    [
      "maven-jar-plugin",
      pick("maven-jar-plugin", (config) => childText(descend(config, "archive", "manifest"), "mainClass")),
    ],
  ];
  for (const [source, raw] of candidates) {
    if (!raw) continue;
    return { value: expand(pom, raw, [], counter), source };
  }
  return null;
}
