/**
 * Compares a scanned graph with hand-written labels (bench/labels/<sample>.json)
 * and counts true positives, false positives and false negatives per
 * relationship type. Pure functions over the scan result, so tests can run
 * them on small graphs.
 */
import type { GraphNode, GraphRelationship } from "../../src/core/graph/model.js";

export type RouteLabel = { method: string; path: string; file: string; line: number };
export type CallTarget = { file: string; name: string; className?: string } | null;
// dynamic: the target is only known at runtime (a generated method, a
// framework-set prototype); the call site is matched but not scored.
// targets: every function a call dispatches to (a Go interface method has one
// per implementer); each target is scored on its own, in place of `target`.
export type CallLabel = { file: string; line: number; callee: string; target: CallTarget; targets?: Array<NonNullable<CallTarget>>; dynamic?: true };
export type DataAccessLabel = { file: string; function: string; model: string; operation: string; table?: string };
// An env variable read; function null for a read outside any function.
export type EnvLabel = { file: string; line: number; name: string; function: string | null };
// A script, make target, npm script, Dockerfile CMD / ENTRYPOINT, compose
// service or CI job (EntryPoint of kind script, make, npm-script, docker,
// compose-service or ci-job); `file` declares it.
export type ScriptLabel = { file: string; line: number; kind: string; trigger: string };
// The entrypoint (`file`, `kind`, `trigger`) runs `target`: a file path, or
// `<file>#<trigger>` for a make target, npm script, compose service, CI job or
// Dockerfile instruction (a script file is its path).
export type RunLabel = { file: string; kind: string; trigger: string; target: string };
// An env variable a script, Dockerfile, compose file or workflow sets, at `file:line`.
export type EnvDeclarationLabel = { file: string; line: number; name: string };
// A use of the class or id `style` (`.btn`, `#hero`) declared in `styleFile`,
// at (file, line) of the component, function or file that uses it; `match` is
// module (styles.btn of a CSS Modules import), import (a sheet the file
// imports) or name (the same class name elsewhere).
export type StyleLinkLabel = { file: string; line: number; style: string; styleFile: string; match: string };
// A table the SQL files declare (a Table with migrations), by name and kind,
// with its columns in DDL order as `name:type`, then `?` when nullable, ` pk`,
// ` unique` and ` -> table.column` for a reference; `scope` matches the file
// that declares it.
export type SqlTableLabel = { name: string; kind: string; columns: string[] };
// An rpc of a `.proto` file (`file`), its messages as written, `streaming`
// (none, client, server or both), the generated Go server interface that
// serves it (null when none does) and the methods that implement it
// (`path#Type.Method`).
export type RpcLabel = { file: string; service: string; name: string; request: string; response: string; streaming: string; served: string | null; implementations: string[] };
// A target of a CMake file or Makefile (a Package of manager cmake or make):
// `file` is the build file that creates it, `kind` executable or library
// (static, shared, module, object and interface libraries), `sources` the
// files it compiles and `links` the targets it links, in some configuration
// (every `if` branch of a CMake file counts).
export type BuildTargetLabel = { file: string; system: string; name: string; kind: string; sources: string[]; links: string[] };
// An `#include` (`source` as written) of a C or C++ file at (file, line) and
// the scanned file it names; null for a header outside the scan (system, third party).
export type IncludeLabel = { file: string; line: number; source: string; target: string | null };
export type ComponentLabel = { file: string; name: string; line: number };
// `file` and `line` are the rendering element's; `parent` is the component it is in.
export type RenderLabel = { file: string; parent: string; line: number; child: string; childFile: string };
// `component` is the name of the component the page renders, or null.
export type PageLabel = { file: string; fullPath: string; kind: string; component: string | null };
// A frontend call (file, line) that reaches the route `route` ("METHOD /path")
// declared in `routeFile`.
export type RequestLabel = { file: string; line: number; route: string; routeFile: string };
export type StoreLabel = { file: string; name: string; library: string; kind: string };
// A use of the store `store` declared in `storeFile` at (file, line), with
// the members it reads and writes (READS_STORE / WRITES_STORE of that line).
export type StoreAccessLabel = { file: string; line: number; store: string; storeFile: string; reads: string[]; writes: string[] };

export type Labels = {
  sample: string;
  // Files or directories (ending in "/") whose routes are labeled.
  routes?: { scope: string[]; items: RouteLabel[] };
  // Every call site in `files` is labeled; target null means it should stay
  // unresolved (a package, a built-in, a callback parameter).
  calls?: { files: string[]; items: CallLabel[] };
  // Direct accesses (the call is in the function's own body) in `scope`.
  dataAccess?: { scope: string[]; items: DataAccessLabel[] };
  // UI components declared in `scope`.
  components?: { scope: string[]; items: ComponentLabel[] };
  // Elements in `scope` that render a component of the repository.
  renders?: { scope: string[]; items: RenderLabel[] };
  // UI pages declared in `scope`.
  pages?: { scope: string[]; items: PageLabel[] };
  // Calls in `scope` that request a route of the repository (REQUESTS).
  requests?: { scope: string[]; items: RequestLabel[] };
  // State stores declared in `scope`.
  stores?: { scope: string[]; items: StoreLabel[] };
  // Store uses in `scope` (hook calls, store references, selectors, dispatches).
  storeAccess?: { scope: string[]; items: StoreAccessLabel[] };
  // Env variable reads in `scope`.
  env?: { scope: string[]; items: EnvLabel[] };
  // Scripts and infrastructure declared in the files of `scope`.
  scripts?: { scope: string[]; items: ScriptLabel[] };
  // What those entrypoints run.
  runs?: { scope: string[]; items: RunLabel[] };
  // Env variables the files of `scope` declare for scripts and infrastructure.
  envDeclarations?: { scope: string[]; items: EnvDeclarationLabel[] };
  // Class and id uses (USES_STYLE) in the files of `scope`.
  styleLinks?: { scope: string[]; items: StyleLinkLabel[] };
  // Tables declared by the SQL files of `scope`.
  sqlTables?: { scope: string[]; items: SqlTableLabel[] };
  // Rpcs of the `.proto` files of `scope`.
  rpcs?: { scope: string[]; items: RpcLabel[] };
  // Targets declared by the CMake files and Makefiles of `scope`.
  buildTargets?: { scope: string[]; items: BuildTargetLabel[] };
  // Every `#include` of the C and C++ files in `files`.
  includes?: { files: string[]; items: IncludeLabel[] };
};

export type Score = {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  falsePositives: string[];
  falseNegatives: string[];
};

type Graph = { nodes: readonly GraphNode[]; relationships: readonly GraphRelationship[] };

export function inScope(file: string, scope: readonly string[]): boolean {
  return scope.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

function score(tp: number, falsePositives: string[], falseNegatives: string[]): Score {
  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  return {
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    falsePositives,
    falseNegatives,
  };
}

// Node ids start with their file's id: `file:<relativePath>:...`.
export function fileOfNodeId(id: string, files: ReadonlySet<string>): string | null {
  if (!id.startsWith("file:")) return null;
  if (files.has(id.slice(5))) return id.slice(5);
  // Longest known prefix: a path may itself contain ":".
  for (let index = id.lastIndexOf(":"); index > 5; index = id.lastIndexOf(":", index - 1)) {
    const candidate = id.slice(5, index);
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function filePaths(graph: Graph): Set<string> {
  return new Set(graph.nodes.flatMap((node) => (
    node.label === "File" && typeof node.properties.relativePath === "string" ? [node.properties.relativePath] : []
  )));
}

const num = (value: unknown) => (typeof value === "number" ? value : Number(value));

// Pairs each label with the first unused found item that `matches` it, so
// duplicates on one line are counted once each.
function pair<L, F>(labels: readonly L[], found: readonly F[], matches: (label: L, item: F) => boolean) {
  const used = new Set<number>();
  const unmatchedLabels: L[] = [];
  for (const label of labels) {
    const index = found.findIndex((item, i) => !used.has(i) && matches(label, item));
    if (index === -1) unmatchedLabels.push(label);
    else used.add(index);
  }
  return { matched: used.size, unmatchedLabels, unmatchedFound: found.filter((_, i) => !used.has(i)) };
}

const nearLine = (a: number, b: number) => Math.abs(a - b) <= 1;

export function scanRoutes(graph: Graph): RouteLabel[] {
  const fileOfRoute = new Map<string, string>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const rel of graph.relationships) {
    if (rel.type !== "DECLARES_ROUTE") continue;
    const file = byId.get(rel.from)?.properties.relativePath;
    if (typeof file === "string") fileOfRoute.set(rel.to, file);
  }
  return graph.nodes.flatMap((node) => {
    const file = fileOfRoute.get(node.id);
    if (node.label !== "Route" || !file) return [];
    const path = node.properties.fullPath ?? node.properties.path;
    return [{ method: String(node.properties.method).toUpperCase(), path: String(path), file, line: num(node.properties.line) }];
  });
}

// `/a//b/` and `/a/b` are the same route.
export const normalizePath = (value: string) => (value.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1") || "/");

export type RouteScore = Score & {
  // Of the detected routes, how many have the labeled full path (mount
  // prefixes included).
  paths: { correct: number; total: number; wrong: string[] };
};

// A route is detected when method, file and line match; its full path is
// scored separately so a missed mount prefix does not count as a missed route.
export function compareRoutes(graph: Graph, labels: NonNullable<Labels["routes"]>): RouteScore {
  // Middleware mounts (`app.use`) are Route nodes with method USE but not endpoints.
  const found = scanRoutes(graph).filter((route) => route.method !== "USE" && inScope(route.file, labels.scope));
  const samePath = (label: RouteLabel, route: RouteLabel) => normalizePath(label.path) === normalizePath(route.path);
  const sameSite = (label: RouteLabel, route: RouteLabel) => (
    label.method.toUpperCase() === route.method && label.file === route.file && nearLine(label.line, route.line)
  );
  // Exact matches first, so two routes on one line pair with the right labels.
  const exact = pair(labels.items, found, (label, route) => sameSite(label, route) && samePath(label, route));
  const rest = pair(exact.unmatchedLabels, exact.unmatchedFound, sameSite);
  const describe = (route: RouteLabel) => `${route.method} ${route.path} (${route.file}:${route.line})`;
  const wrong = exact.unmatchedLabels
    .filter((label) => !rest.unmatchedLabels.includes(label))
    .map((label) => `${describe(label)} found as ${found.find((route) => sameSite(label, route) && !samePath(label, route))?.path}`);
  return {
    ...score(exact.matched + rest.matched, rest.unmatchedFound.map(describe), rest.unmatchedLabels.map(describe)),
    paths: { correct: exact.matched, total: exact.matched + rest.matched, wrong },
  };
}

export type FoundCall = { file: string; line: number; callee: string; target: CallTarget; targets: Array<NonNullable<CallTarget>> };

export function scanCalls(graph: Graph, files: readonly string[]): FoundCall[] {
  const paths = filePaths(graph);
  const wanted = new Set(files);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const targetsOf = new Map<string, string[]>();
  for (const rel of graph.relationships) {
    if (rel.type === "CALL_RESOLVES_TO") targetsOf.set(rel.from, [...targetsOf.get(rel.from) ?? [], rel.to]);
  }
  return graph.nodes.flatMap((node) => {
    if (node.label !== "Call") return [];
    const file = fileOfNodeId(node.id, paths);
    if (!file || !wanted.has(file)) return [];
    const targets = (targetsOf.get(node.id) ?? []).flatMap((targetId) => {
      const target = byId.get(targetId);
      const targetFile = fileOfNodeId(targetId, paths);
      return target && targetFile
        ? [{
          file: targetFile,
          name: String(target.properties.name),
          ...(typeof target.properties.className === "string" ? { className: target.properties.className } : {}),
        }]
        : [];
    });
    return [{ file, line: num(node.properties.line), callee: String(node.properties.callee ?? node.properties.name), target: targets[0] ?? null, targets }];
  });
}

// A labeled constructor (`new X` -> X's constructor) also matches the class itself.
const sameTarget = (label: CallTarget, found: CallTarget) => {
  if (label === null || found === null) return label === found;
  if (label.file !== found.file) return false;
  if (label.name === found.name && (label.className ?? null) === (found.className ?? null)) return true;
  return label.name === "constructor" && found.name === label.className && found.className === undefined;
};

// Resolution accuracy at labeled call sites:
// - tp: the call resolves to the labeled target;
// - fp: it resolves where it should not (a wrong target, or a target for a
//   call labeled unresolved, or a call site the labels do not have);
// - fn: a labeled target the scan misses (unresolved, wrong, or no call node).
export function compareCalls(graph: Graph, labels: NonNullable<Labels["calls"]>): Score {
  const found = scanCalls(graph, labels.files);
  let tp = 0;
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];
  const describe = (call: { file: string; line: number; callee: string }, target: CallTarget) =>
    `${call.file}:${call.line} ${call.callee} -> ${target ? `${target.file} ${target.className ? `${target.className}.` : ""}${target.name}` : "(unresolved)"}`;

  const usedFound = new Set<FoundCall>();
  for (const label of labels.items) {
    // The exact line first, so same-named calls on adjacent lines pair up right.
    const candidates = found.filter((item) => !usedFound.has(item) && label.file === item.file && label.callee === item.callee && nearLine(label.line, item.line));
    const call = candidates.find((item) => item.line === label.line) ?? candidates[0];
    if (call) usedFound.add(call);
    if (label.dynamic) continue;
    const expected = label.targets ?? (label.target ? [label.target] : []);
    const targets = call?.targets ?? [];
    for (const target of expected) {
      if (targets.some((item) => sameTarget(target, item))) tp++;
      else falseNegatives.push(describe(label, target));
    }
    for (const target of targets) {
      if (!expected.some((item) => sameTarget(item, target))) falsePositives.push(describe(label, target));
    }
  }
  for (const call of found.filter((item) => !usedFound.has(item))) {
    for (const target of call.targets) falsePositives.push(`${describe(call, target)} (call site not labeled)`);
  }
  return score(tp, falsePositives, falseNegatives);
}

export type FoundAccess = { file: string; function: string; model: string; table: string | null; operation: string };

// Direct data accesses: ACCESSES_DATA edges from a function whose own Call
// node (same line and expression) made the access; propagated edges to
// callers are left out.
export function scanDataAccess(graph: Graph): FoundAccess[] {
  const paths = filePaths(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const callsByFunction = new Map<string, Array<{ line: number; expression: string }>>();
  const tableOf = new Map<string, string>();
  for (const rel of graph.relationships) {
    if (rel.type === "CALLS") {
      const call = byId.get(rel.to);
      if (!call) continue;
      const list = callsByFunction.get(rel.from) ?? [];
      list.push({ line: num(call.properties.line), expression: String(call.properties.expression) });
      callsByFunction.set(rel.from, list);
    } else if (rel.type === "MAPS_TO_TABLE") {
      const table = byId.get(rel.to)?.properties.name;
      if (typeof table === "string") tableOf.set(rel.from, table);
    }
  }
  return graph.relationships.flatMap((rel) => {
    if (rel.type !== "ACCESSES_DATA") return [];
    const source = byId.get(rel.from);
    const model = byId.get(rel.to);
    if (source?.label !== "Function" || !model) return [];
    // The function's own access: a call it makes (by line and expression), or
    // one a framework layer marked direct (Rust macros are not Call nodes).
    const own = rel.properties.direct === true || (callsByFunction.get(rel.from) ?? []).some((call) => (
      call.line === num(rel.properties.line) && call.expression === String(rel.properties.expression)
    ));
    const file = fileOfNodeId(rel.from, paths);
    if (!own || !file) return [];
    return [{
      file,
      function: String(source.properties.name),
      model: String(model.properties.name),
      table: tableOf.get(rel.to) ?? null,
      operation: String(rel.properties.operation),
    }];
  });
}

export function compareDataAccess(graph: Graph, labels: NonNullable<Labels["dataAccess"]>): Score {
  // One finding per (function, model, operation): several calls of the same
  // kind in one function are one access.
  const unique = new Map<string, FoundAccess>();
  for (const access of scanDataAccess(graph)) {
    if (!inScope(access.file, labels.scope)) continue;
    unique.set(`${access.file}\0${access.function}\0${access.model}\0${access.operation}`, access);
  }
  const found = [...unique.values()];
  const result = pair(labels.items, found, (label, access) => (
    label.file === access.file
    && label.function === access.function
    && label.model === access.model
    && label.operation === access.operation
    && (label.table === undefined || label.table === access.table)
  ));
  const describe = (access: { file: string; function: string; model: string; operation: string; table?: string | null }) =>
    `${access.file} ${access.function}: ${access.operation} ${access.model}${access.table ? ` (${access.table})` : ""}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

// Component nodes with their declaring file.
export function scanComponents(graph: Graph): ComponentLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships.flatMap((rel) => {
    if (rel.type !== "DECLARES_COMPONENT") return [];
    const file = byId.get(rel.from)?.properties.relativePath;
    const component = byId.get(rel.to);
    return typeof file === "string" && component
      ? [{ file, name: String(component.properties.name), line: num(component.properties.line) }]
      : [];
  });
}

export function compareComponents(graph: Graph, labels: NonNullable<Labels["components"]>): Score {
  const found = scanComponents(graph).filter((component) => inScope(component.file, labels.scope));
  const result = pair(labels.items, found, (label, component) => (
    label.file === component.file && label.name === component.name && nearLine(label.line, component.line)
  ));
  const describe = (component: ComponentLabel) => `${component.file}:${component.line} ${component.name}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

export function scanRenders(graph: Graph): RenderLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileOf = new Map<string, string>();
  for (const rel of graph.relationships) {
    const file = rel.type === "DECLARES_COMPONENT" ? byId.get(rel.from)?.properties.relativePath : undefined;
    if (typeof file === "string") fileOf.set(rel.to, file);
  }
  return graph.relationships.flatMap((rel) => {
    if (rel.type !== "RENDERS") return [];
    const file = fileOf.get(rel.from);
    const childFile = fileOf.get(rel.to);
    if (!file || !childFile) return [];
    return [{
      file,
      parent: String(byId.get(rel.from)?.properties.name),
      line: num(rel.properties.line),
      child: String(byId.get(rel.to)?.properties.name),
      childFile,
    }];
  });
}

// A render is right when the element (parent, line) links to the labeled
// component; a link to another component is both a false positive and a
// false negative.
export function compareRenders(graph: Graph, labels: NonNullable<Labels["renders"]>): Score {
  const found = scanRenders(graph).filter((render) => inScope(render.file, labels.scope));
  const result = pair(labels.items, found, (label, render) => (
    label.file === render.file
    && label.parent === render.parent
    && nearLine(label.line, render.line)
    && label.child === render.child
    && label.childFile === render.childFile
  ));
  const describe = (render: RenderLabel) => `${render.file}:${render.line} ${render.parent} -> ${render.childFile} ${render.child}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

// Page nodes with their declaring file and the component they render.
export function scanPages(graph: Graph): PageLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileOf = new Map<string, string>();
  const componentOf = new Map<string, string>();
  for (const rel of graph.relationships) {
    const file = rel.type === "DECLARES_PAGE" ? byId.get(rel.from)?.properties.relativePath : undefined;
    if (typeof file === "string") fileOf.set(rel.to, file);
    if (rel.type === "PAGE_RENDERS") componentOf.set(rel.from, String(byId.get(rel.to)?.properties.name));
  }
  return graph.nodes.flatMap((node) => {
    const file = fileOf.get(node.id);
    if (node.label !== "Page" || !file) return [];
    return [{ file, fullPath: String(node.properties.fullPath), kind: String(node.properties.kind), component: componentOf.get(node.id) ?? null }];
  });
}

// A page is right when its file, kind, full path and rendered component all match.
export function comparePages(graph: Graph, labels: NonNullable<Labels["pages"]>): Score {
  const found = scanPages(graph).filter((page) => inScope(page.file, labels.scope));
  const result = pair(labels.items, found, (label, page) => (
    label.file === page.file && label.kind === page.kind && label.fullPath === page.fullPath && label.component === page.component
  ));
  const describe = (page: PageLabel) => `${page.file} ${page.kind} ${page.fullPath} -> ${page.component ?? "(none)"}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

// REQUESTS edges with the calling file and line and the route's declaring file.
export function scanRequests(graph: Graph): RequestLabel[] {
  const files = filePaths(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileOfRoute = new Map<string, string>();
  for (const rel of graph.relationships) {
    const file = rel.type === "DECLARES_ROUTE" ? byId.get(rel.from)?.properties.relativePath : undefined;
    if (typeof file === "string") fileOfRoute.set(rel.to, file);
  }
  return graph.relationships.flatMap((rel) => {
    if (rel.type !== "REQUESTS") return [];
    const call = byId.get(rel.from);
    const route = byId.get(rel.to);
    const file = fileOfNodeId(rel.from, files);
    if (!call || !route || !file) return [];
    const path = route.properties.fullPath ?? route.properties.path;
    return [{
      file,
      line: num(call.properties.line),
      route: `${String(route.properties.method).toUpperCase()} ${String(path)}`,
      routeFile: fileOfRoute.get(rel.to) ?? "",
    }];
  });
}

// A request is right when the call (file, line) links to the labeled route; a
// link to another route is both a false positive and a false negative.
export function compareRequests(graph: Graph, labels: NonNullable<Labels["requests"]>): Score {
  const found = scanRequests(graph).filter((request) => inScope(request.file, labels.scope));
  const result = pair(labels.items, found, (label, request) => (
    label.file === request.file && nearLine(label.line, request.line) && label.route === request.route && label.routeFile === request.routeFile
  ));
  const describe = (request: RequestLabel) => `${request.file}:${request.line} -> ${request.route} (${request.routeFile})`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

// Store nodes with their declaring file.
export function scanStores(graph: Graph): StoreLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships.flatMap((rel) => {
    const file = rel.type === "DECLARES_STORE" ? byId.get(rel.from)?.properties.relativePath : undefined;
    const store = byId.get(rel.to);
    if (typeof file !== "string" || !store) return [];
    return [{ file, name: String(store.properties.name), library: String(store.properties.library), kind: String(store.properties.kind) }];
  });
}

export function compareStores(graph: Graph, labels: NonNullable<Labels["stores"]>): Score {
  const found = scanStores(graph).filter((store) => inScope(store.file, labels.scope));
  const result = pair(labels.items, found, (label, store) => (
    label.file === store.file && label.name === store.name && label.library === store.library && label.kind === store.kind
  ));
  const describe = (store: StoreLabel) => `${store.file} ${store.library} ${store.kind} ${store.name}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

// READS_STORE and WRITES_STORE edges, merged per function, line and store.
export function scanStoreAccess(graph: Graph): StoreAccessLabel[] {
  const files = filePaths(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileOfStore = new Map<string, string>();
  for (const rel of graph.relationships) {
    const file = rel.type === "DECLARES_STORE" ? byId.get(rel.from)?.properties.relativePath : undefined;
    if (typeof file === "string") fileOfStore.set(rel.to, file);
  }
  const uses = new Map<string, StoreAccessLabel>();
  for (const rel of graph.relationships) {
    if (rel.type !== "READS_STORE" && rel.type !== "WRITES_STORE") continue;
    const file = fileOfNodeId(rel.from, files);
    const storeFile = fileOfStore.get(rel.to);
    if (!file || !storeFile) continue;
    const line = num(rel.properties.line);
    const key = `${rel.from}\0${line}\0${rel.to}`;
    const use = uses.get(key) ?? { file, line, store: String(byId.get(rel.to)?.properties.name), storeFile, reads: [], writes: [] };
    const members = String(rel.properties.members ?? "").split(",").filter(Boolean);
    (rel.type === "READS_STORE" ? use.reads : use.writes).push(...members);
    uses.set(key, use);
  }
  return [...uses.values()];
}

const sameMembers = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((member) => right.has(member));
};

// A use is right when (file, line ±1) reaches the labeled store with the
// labeled members read and written; other members are an FP and an FN.
export function compareStoreAccess(graph: Graph, labels: NonNullable<Labels["storeAccess"]>): Score {
  const found = scanStoreAccess(graph).filter((use) => inScope(use.file, labels.scope));
  const result = pair(labels.items, found, (label, use) => (
    label.file === use.file
    && nearLine(label.line, use.line)
    && label.store === use.store
    && label.storeFile === use.storeFile
    && sameMembers(label.reads, use.reads)
    && sameMembers(label.writes, use.writes)
  ));
  const describe = (use: StoreAccessLabel) =>
    `${use.file}:${use.line} -> ${use.storeFile} ${use.store} reads [${[...new Set(use.reads)].sort().join(",")}] writes [${[...new Set(use.writes)].sort().join(",")}]`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

export function sumScores(scores: readonly Score[]): Score {
  return score(
    scores.reduce((total, entry) => total + entry.tp, 0),
    scores.flatMap((entry) => entry.falsePositives),
    scores.flatMap((entry) => entry.falseNegatives),
  );
}

// Env reads: each file-level USES_ENV, with the function that reads it at
// that line (null at package level).
export function scanEnvReads(graph: Graph): EnvLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const functionsByRead = new Map<string, string>();
  const fileOfFunction = new Map<string, string>();
  for (const rel of graph.relationships) {
    if (rel.type === "DEFINES_FUNCTION") fileOfFunction.set(rel.to, rel.from);
  }
  for (const rel of graph.relationships) {
    if (rel.type !== "USES_ENV" || byId.get(rel.from)?.label !== "Function") continue;
    const file = fileOfFunction.get(rel.from) ?? rel.from.slice(0, rel.from.indexOf(":function:"));
    functionsByRead.set(`${file}\0${rel.to}\0${rel.properties.line}`, String(byId.get(rel.from)?.properties.name));
  }
  const reads = new Map<string, EnvLabel>();
  for (const rel of graph.relationships) {
    const file = byId.get(rel.from);
    if (rel.type !== "USES_ENV" || file?.label !== "File") continue;
    const name = byId.get(rel.to)?.properties.name;
    if (typeof name !== "string") continue;
    const line = num(rel.properties.line);
    reads.set(`${rel.from}\0${name}\0${line}`, {
      file: String(file.properties.relativePath),
      line,
      name,
      function: functionsByRead.get(`${rel.from}\0${rel.to}\0${rel.properties.line}`) ?? null,
    });
  }
  return [...reads.values()];
}

export function compareEnv(graph: Graph, labels: NonNullable<Labels["env"]>): Score {
  const found = scanEnvReads(graph).filter((read) => inScope(read.file, labels.scope));
  const result = pair(labels.items, found, (label, read) => (
    label.file === read.file && label.name === read.name && label.function === read.function && nearLine(label.line, read.line)
  ));
  const describe = (read: EnvLabel) => `${read.file}:${read.line} ${read.function ?? "<file>"}: ${read.name}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

const SCRIPT_KINDS = new Set(["script", "make", "npm-script", "docker", "compose-service", "ci-job"]);

// The file that declares each entrypoint node.
function declaringFiles(graph: Graph): Map<string, string> {
  const files = new Map(graph.nodes.flatMap((node) => (node.label === "File" ? [[node.id, String(node.properties.relativePath)] as const] : [])));
  const declared = new Map<string, string>();
  for (const rel of graph.relationships) {
    const file = rel.type === "DECLARES_ENTRYPOINT" ? files.get(rel.from) : undefined;
    if (file !== undefined) declared.set(rel.to, file);
  }
  return declared;
}

export function scanScripts(graph: Graph): ScriptLabel[] {
  const declared = declaringFiles(graph);
  return graph.nodes.flatMap((node) => {
    const file = declared.get(node.id);
    if (node.label !== "EntryPoint" || file === undefined || !SCRIPT_KINDS.has(String(node.properties.kind))) return [];
    return [{ file, line: num(node.properties.line), kind: String(node.properties.kind), trigger: String(node.properties.trigger) }];
  });
}

export function compareScripts(graph: Graph, labels: NonNullable<Labels["scripts"]>): Score {
  const found = scanScripts(graph).filter((script) => inScope(script.file, labels.scope));
  const result = pair(labels.items, found, (label, script) => (
    label.file === script.file && label.kind === script.kind && label.trigger === script.trigger && nearLine(label.line, script.line)
  ));
  const describe = (script: ScriptLabel) => `${script.file}:${script.line} ${script.kind} ${script.trigger}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

export function scanRuns(graph: Graph): RunLabel[] {
  const declared = declaringFiles(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const runs: RunLabel[] = [];
  for (const rel of graph.relationships) {
    if (rel.type !== "RUNS") continue;
    const runner = byId.get(rel.from);
    const target = byId.get(rel.to);
    const file = declared.get(rel.from);
    if (!runner || !target || file === undefined) continue;
    let targetKey: string;
    if (target.label === "File") {
      targetKey = String(target.properties.relativePath);
    } else {
      const targetFile = declared.get(target.id);
      if (targetFile === undefined) continue;
      targetKey = target.properties.kind === "script" ? targetFile : `${targetFile}#${String(target.properties.trigger)}`;
    }
    const key = `${rel.from}\0${targetKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runs.push({ file, kind: String(runner.properties.kind), trigger: String(runner.properties.trigger), target: targetKey });
  }
  return runs;
}

export function compareRuns(graph: Graph, labels: NonNullable<Labels["runs"]>): Score {
  const found = scanRuns(graph).filter((run) => inScope(run.file, labels.scope));
  const result = pair(labels.items, found, (label, run) => (
    label.file === run.file && label.kind === run.kind && label.trigger === run.trigger && label.target === run.target
  ));
  const describe = (run: RunLabel) => `${run.file} ${run.kind} ${run.trigger} -> ${run.target}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

export function scanEnvDeclarations(graph: Graph): EnvDeclarationLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Map<string, EnvDeclarationLabel>();
  for (const rel of graph.relationships) {
    if (rel.type !== "DECLARES_ENV") continue;
    const name = byId.get(rel.to)?.properties.name;
    if (typeof name !== "string") continue;
    const declaration = { file: String(rel.properties.file), line: num(rel.properties.line), name };
    seen.set(`${declaration.file}\0${declaration.line}\0${name}`, declaration);
  }
  return [...seen.values()];
}

export function compareEnvDeclarations(graph: Graph, labels: NonNullable<Labels["envDeclarations"]>): Score {
  const found = scanEnvDeclarations(graph).filter((declaration) => inScope(declaration.file, labels.scope));
  const result = pair(labels.items, found, (label, declaration) => (
    label.file === declaration.file && label.name === declaration.name && label.line === declaration.line
  ));
  const describe = (declaration: EnvDeclarationLabel) => `${declaration.file}:${declaration.line} ${declaration.name}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

export function scanStyleLinks(graph: Graph): StyleLinkLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileOf = new Map<string, string>();
  const classFile = new Map<string, string>();
  for (const rel of graph.relationships) {
    const from = byId.get(rel.from);
    if (!from) continue;
    if (rel.type === "DECLARES_STYLE" || rel.type === "DECLARES_COMPONENT" || rel.type === "DEFINES_FUNCTION" || rel.type === "DEFINES_CLASS") {
      if (from.label === "File") fileOf.set(rel.to, String(from.properties.relativePath));
    }
    if (rel.type === "DEFINES_METHOD" && fileOf.has(rel.from)) classFile.set(rel.to, fileOf.get(rel.from)!);
  }
  const seen = new Map<string, StyleLinkLabel>();
  for (const rel of graph.relationships) {
    if (rel.type !== "USES_STYLE") continue;
    const owner = byId.get(rel.from);
    const style = byId.get(rel.to);
    if (!owner || !style || (style.properties.kind !== "class" && style.properties.kind !== "id")) continue;
    const file = owner.label === "File" ? String(owner.properties.relativePath) : fileOf.get(owner.id) ?? classFile.get(owner.id);
    const styleFile = fileOf.get(style.id);
    if (file === undefined || styleFile === undefined) continue;
    const link = {
      file,
      line: num(rel.properties.line),
      style: `${style.properties.kind === "id" ? "#" : "."}${String(style.properties.name)}`,
      styleFile,
      match: String(rel.properties.match),
    };
    seen.set(`${link.file}\0${link.line}\0${link.style}\0${link.styleFile}`, link);
  }
  return [...seen.values()];
}

export function compareStyleLinks(graph: Graph, labels: NonNullable<Labels["styleLinks"]>): Score {
  const found = scanStyleLinks(graph).filter((link) => inScope(link.file, labels.scope));
  const result = pair(labels.items, found, (label, link) => (
    label.file === link.file && label.line === link.line && label.style === link.style && label.styleFile === link.styleFile && label.match === link.match
  ));
  const describe = (link: StyleLinkLabel) => `${link.file}:${link.line} ${link.style} (${link.styleFile}, ${link.match})`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

export function scanSqlTables(graph: Graph): Array<SqlTableLabel & { declaredIn: string }> {
  return graph.nodes.flatMap((node) => {
    if (node.label !== "Table" || typeof node.properties.migrations !== "string" || node.properties.migrations === "[]") return [];
    const columns = (JSON.parse(String(node.properties.columns ?? "[]")) as Array<Record<string, unknown>>).map((column) =>
      `${String(column.name)}:${String(column.type).toLowerCase()}${column.optional ? "?" : ""}${column.isId ? " pk" : ""}${column.isUnique ? " unique" : ""}${column.references ? ` -> ${String(column.references)}` : ""}`);
    return [{ name: String(node.properties.name), kind: String(node.properties.kind), columns, declaredIn: String(node.properties.declaredIn) }];
  });
}

export function compareSqlTables(graph: Graph, labels: NonNullable<Labels["sqlTables"]>): Score {
  const found = scanSqlTables(graph).filter((table) => inScope(table.declaredIn, labels.scope));
  const result = pair(labels.items, found, (label, table) => (
    label.name === table.name && label.kind === table.kind && JSON.stringify(label.columns) === JSON.stringify(table.columns)
  ));
  const describe = (table: SqlTableLabel) => `${table.name} (${table.kind}) ${table.columns.join(", ")}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

export function scanRpcs(graph: Graph): Array<RpcLabel> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const serviceFile = new Map<string, string>();
  const rpcService = new Map<string, string>();
  for (const rel of graph.relationships) {
    if (rel.type === "DECLARES_SERVICE") serviceFile.set(rel.to, String(byId.get(rel.from)?.properties.relativePath));
    if (rel.type === "HAS_RPC") rpcService.set(rel.to, rel.from);
  }
  const served = new Map<string, string>();
  const implementations = new Map<string, string[]>();
  for (const rel of graph.relationships) {
    if (rel.type === "RPC_SERVED_BY") served.set(rel.from, String(byId.get(rel.to)?.properties.name));
    if (rel.type === "RPC_IMPLEMENTED_BY") {
      const fn = byId.get(rel.to);
      if (!fn) continue;
      const file = rel.to.replace(/^file:/u, "").split(":function:")[0]!;
      const list = implementations.get(rel.from) ?? [];
      list.push(`${file}#${fn.properties.className ?? ""}.${String(fn.properties.name)}`);
      implementations.set(rel.from, list);
    }
  }
  return graph.nodes.flatMap((node) => {
    if (node.label !== "Rpc") return [];
    const file = serviceFile.get(rpcService.get(node.id) ?? "");
    if (file === undefined) return [];
    const client = node.properties.clientStreaming === true;
    const server = node.properties.serverStreaming === true;
    return [{
      file,
      service: String(node.properties.service),
      name: String(node.properties.name),
      request: String(node.properties.request),
      response: String(node.properties.response),
      streaming: client && server ? "both" : client ? "client" : server ? "server" : "none",
      served: served.get(node.id) ?? null,
      implementations: (implementations.get(node.id) ?? []).sort(),
    }];
  });
}

export function compareRpcs(graph: Graph, labels: NonNullable<Labels["rpcs"]>): Score {
  const found = scanRpcs(graph).filter((rpc) => inScope(rpc.file, labels.scope));
  const result = pair(labels.items, found, (label, rpc) => (
    label.file === rpc.file && label.service === rpc.service && label.name === rpc.name && label.request === rpc.request
    && label.response === rpc.response && label.streaming === rpc.streaming && label.served === rpc.served
    && JSON.stringify([...label.implementations].sort()) === JSON.stringify(rpc.implementations)
  ));
  const describe = (rpc: RpcLabel) => `${rpc.service}/${rpc.name} (${rpc.request}) -> ${rpc.response} [${rpc.streaming}] served by ${rpc.served ?? "-"}; ${rpc.implementations.join(", ") || "no implementation"}`;
  return score(result.matched, result.unmatchedFound.map(describe), result.unmatchedLabels.map(describe));
}

// Targets as atoms: the target itself (build file, system, name, kind), each
// source it compiles and each target it links.
export function scanBuildTargets(graph: Graph): BuildTargetLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const targets = new Map<string, BuildTargetLabel>();
  for (const node of graph.nodes) {
    if (node.label !== "Package" || (node.properties.manager !== "cmake" && node.properties.manager !== "make")) continue;
    targets.set(node.id, {
      file: String(node.properties.buildFile),
      system: String(node.properties.manager),
      name: String(node.properties.name),
      kind: node.properties.targetType === "executable" ? "executable" : "library",
      sources: [],
      links: [],
    });
  }
  for (const rel of graph.relationships) {
    const target = targets.get(rel.from);
    if (!target) continue;
    if (rel.type === "PACKAGE_CONTAINS_FILE") target.sources.push(rel.to.replace(/^file:/u, ""));
    else if (rel.type === "PACKAGE_IMPORTS_PACKAGE") target.links.push(String(byId.get(rel.to)?.properties.name));
  }
  return [...targets.values()];
}

function buildTargetAtoms(targets: readonly BuildTargetLabel[]): string[] {
  return targets.flatMap((target) => [
    `target ${target.file} ${target.system}:${target.name} ${target.kind}`,
    ...target.sources.map((source) => `source ${target.system}:${target.name} ${source}`),
    ...target.links.map((link) => `link ${target.system}:${target.name} -> ${link}`),
  ]);
}

export function compareBuildTargets(graph: Graph, labels: NonNullable<Labels["buildTargets"]>): Score {
  const found = buildTargetAtoms(scanBuildTargets(graph).filter((target) => inScope(target.file, labels.scope)));
  const expected = buildTargetAtoms(labels.items);
  const result = pair(expected, found, (label, atom) => label === atom);
  return score(result.matched, result.unmatchedFound, result.unmatchedLabels);
}

export function scanIncludes(graph: Graph): IncludeLabel[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const owner = new Map<string, string>();
  const target = new Map<string, string>();
  for (const rel of graph.relationships) {
    if (rel.type === "IMPORTS") owner.set(rel.to, rel.from.replace(/^file:/u, ""));
    else if (rel.type === "RESOLVES_TO" && rel.from.includes(":import:")) target.set(rel.from, rel.to.replace(/^file:/u, ""));
  }
  return [...owner].flatMap(([id, file]) => {
    const node = byId.get(id);
    if (!node || typeof node.properties.isSystem !== "boolean" || !/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp)$/u.test(file)) return [];
    return [{ file, line: num(node.properties.line), source: String(node.properties.source), target: target.get(id) ?? null }];
  });
}

export function compareIncludes(graph: Graph, labels: NonNullable<Labels["includes"]>): Score {
  const found = scanIncludes(graph).filter((item) => labels.files.includes(item.file));
  const key = (item: IncludeLabel) => `${item.file}:${item.line} ${item.source}`;
  const labeled = new Map(labels.items.map((item) => [key(item), item.target]));
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];
  let tp = 0;
  for (const item of found) {
    const expected = labeled.get(key(item));
    if (item.target === null) continue;
    if (expected === item.target) tp += 1;
    else falsePositives.push(`${key(item)} -> ${item.target} (labeled ${expected ?? "<unlabeled>"})`);
  }
  const resolved = new Map(found.map((item) => [key(item), item.target]));
  for (const item of labels.items) {
    if (item.target !== null && resolved.get(key(item)) === null) falseNegatives.push(`${key(item)} -> ${item.target}`);
  }
  return score(tp, falsePositives, falseNegatives);
}
