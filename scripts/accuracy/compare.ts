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
export type CallLabel = { file: string; line: number; callee: string; target: CallTarget; dynamic?: true };
export type DataAccessLabel = { file: string; function: string; model: string; operation: string; table?: string };
export type ComponentLabel = { file: string; name: string; line: number };
// `file` and `line` are the rendering element's; `parent` is the component it is in.
export type RenderLabel = { file: string; parent: string; line: number; child: string; childFile: string };

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

export type FoundCall = { file: string; line: number; callee: string; target: CallTarget };

export function scanCalls(graph: Graph, files: readonly string[]): FoundCall[] {
  const paths = filePaths(graph);
  const wanted = new Set(files);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const targetOf = new Map<string, string>();
  for (const rel of graph.relationships) {
    if (rel.type === "CALL_RESOLVES_TO") targetOf.set(rel.from, rel.to);
  }
  return graph.nodes.flatMap((node) => {
    if (node.label !== "Call") return [];
    const file = fileOfNodeId(node.id, paths);
    if (!file || !wanted.has(file)) return [];
    const targetId = targetOf.get(node.id);
    const target = targetId ? byId.get(targetId) : undefined;
    const targetFile = targetId ? fileOfNodeId(targetId, paths) : null;
    return [{
      file,
      line: num(node.properties.line),
      callee: String(node.properties.callee ?? node.properties.name),
      target: target && targetFile
        ? {
          file: targetFile,
          name: String(target.properties.name),
          ...(typeof target.properties.className === "string" ? { className: target.properties.className } : {}),
        }
        : null,
    }];
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
    const target = call?.target ?? null;
    if (label.target && sameTarget(label.target, target)) {
      tp++;
      continue;
    }
    if (target && !sameTarget(label.target, target)) falsePositives.push(describe(label, target));
    if (label.target) falseNegatives.push(describe(label, label.target));
  }
  for (const call of found.filter((item) => !usedFound.has(item))) {
    if (call.target) falsePositives.push(`${describe(call, call.target)} (call site not labeled)`);
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
    const own = (callsByFunction.get(rel.from) ?? []).some((call) => (
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

export function sumScores(scores: readonly Score[]): Score {
  return score(
    scores.reduce((total, entry) => total + entry.tp, 0),
    scores.flatMap((entry) => entry.falsePositives),
    scores.flatMap((entry) => entry.falseNegatives),
  );
}
