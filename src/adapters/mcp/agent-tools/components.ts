import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalInteger, optionalString, requiredString } from "../args.js";
import type { PageWindow } from "../paging.js";
import {
  byFileAndLine,
  describeFunction,
  loadComponentFunctions,
  loadComponents,
  loadFunctions,
  loadRenderEdges,
  matchesFile,
  walkCalls,
  type ComponentInfo,
  type RenderEdge,
} from "./graph.js";

type Row = Record<string, unknown>;

// How many custom-hook levels to follow when collecting the contexts a
// component reads.
const HOOK_DEPTH = 10;

// component_tree: one component (or several with the same name) with what it
// renders and what renders it, each up to `depth` levels, its props at each
// render site, its hooks and the contexts it reads directly or through hooks.
export async function componentTree(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const name = requiredString(args.name, "name");
  const file = optionalString(args.file);
  const depth = optionalInteger(args.depth, 2, 1, 10);

  const [components, renders] = await Promise.all([loadComponents(engine), loadRenderEdges(engine)]);
  const matches = matchComponents(components, name, file);
  if (matches.length === 0) {
    return { name, file: file ?? null, components: [], note: "No component matched. Use search_symbols to look the name up." };
  }
  const page = window.take(matches);

  const [implementations, functions, hookEdges, contextEdges] = await Promise.all([
    loadComponentFunctions(engine),
    loadFunctions(engine),
    engine.query(`
      MATCH (user:Function)-[rel:USES_HOOK]->(hook:Function)
      RETURN id(user) AS user, id(hook) AS hook, rel.line AS line
    `),
    engine.query(`
      MATCH (user:Function)-[rel:USES_CONTEXT]->(context:Component)
      RETURN id(user) AS user, id(context) AS context, rel.line AS line
    `),
  ]) as [Awaited<ReturnType<typeof loadComponentFunctions>>, Awaited<ReturnType<typeof loadFunctions>>, Row[], Row[]];
  const describe = (id: string) => describeFunction(functions.get(id), id);
  const component = (id: string) => components.get(id);

  const trees = page.map((target) => {
    const own = implementations.filter((row) => row.component === target.id);
    const definedBy = own.length === 0
      ? null
      : own[0]!.className
        ? { kind: "class", name: own[0]!.className }
        : { kind: "function", ...describe(own[0]!.fn) };

    // Custom hooks, followed through the hooks they use.
    const hookDepth = walkCalls(
      hookEdges.map((row) => ({ caller: String(row.user), callee: String(row.hook), line: null })),
      own.map((row) => row.fn),
      "down",
      HOOK_DEPTH,
    );
    const customHooks = hookEdges
      .filter((row) => hookDepth.get(String(row.user)) === 0)
      .map((row) => ({ ...describe(String(row.hook)), calledAt: row.line ?? null }));
    const contexts = contextEdges
      .filter((row) => hookDepth.has(String(row.user)))
      .map((row) => {
        const context = component(String(row.context));
        const through = hookDepth.get(String(row.user))! > 0 ? describe(String(row.user)).name : null;
        return { name: context?.name ?? String(row.context), file: context?.file ?? null, line: context?.line ?? null, ...(through ? { through } : {}) };
      });

    return {
      ...summary(target),
      definedBy,
      hooks: target.hooks,
      customHooks: dedupe(customHooks).sort(byFileAndLine),
      contexts: dedupe(contexts).sort(byFileAndLine),
      renders: renderLevels(renders, target.id, "down", depth, component),
      unresolvedRenders: target.unresolvedRenders,
      renderedBy: renderLevels(renders, target.id, "up", depth, component),
    };
  });
  return { name, file: file ?? null, depth, components: trees };
}

// find_component_usages: every place a component is rendered, with the
// rendering component and the props passed; for a context also the functions
// that read it. A name that only appears as an unresolved element (a library
// component such as `Link`) lists those render sites as `resolved: false`.
export async function findComponentUsages(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const name = requiredString(args.name, "name");
  const file = optionalString(args.file);

  const [components, renders] = await Promise.all([loadComponents(engine), loadRenderEdges(engine)]);
  const matches = matchComponents(components, name, file);
  const ids = new Set(matches.map((match) => match.id));
  const several = matches.length > 1;
  const target = (id: string) => {
    const match = components.get(id);
    return several && match ? { target: `${match.file}:${match.line ?? "?"}` } : {};
  };

  const usages: Row[] = renders
    .filter((edge) => ids.has(edge.child))
    .map((edge) => {
      const parent = components.get(edge.parent);
      return { kind: "render", file: parent?.file ?? null, line: edge.line, from: parent?.name ?? edge.parent, props: edge.props, ...target(edge.child) };
    });

  const contextIds = matches.filter((match) => match.kind === "context").map((match) => match.id);
  if (contextIds.length > 0) {
    const [functions, readers] = await Promise.all([
      loadFunctions(engine),
      engine.query(`
        MATCH (user:Function)-[rel:USES_CONTEXT]->(context:Component)
        WHERE id(context) IN $ids
        RETURN id(user) AS user, id(context) AS context, rel.line AS line
      `, { ids: contextIds }),
    ]) as [Awaited<ReturnType<typeof loadFunctions>>, Row[]];
    for (const row of readers) {
      const user = describeFunction(functions.get(String(row.user)), String(row.user));
      usages.push({ kind: "context", file: user.file, line: row.line ?? null, from: user.name, ...target(String(row.context)) });
    }
  }

  // Elements with this name that resolved to no component.
  if (!file) {
    for (const parent of components.values()) {
      for (const render of parent.unresolvedRenders) {
        if (render.name !== name) continue;
        usages.push({ kind: "render", file: parent.file, line: render.line, from: parent.name, props: render.props, resolved: false });
      }
    }
  }

  if (matches.length === 0 && usages.length === 0) {
    return { name, file: file ?? null, components: [], usages: [], note: "No component matched. Use search_symbols to look the name up." };
  }
  usages.sort((a, b) => byFileAndLine(a, b) || String(a.kind).localeCompare(String(b.kind)));
  const counts: Record<string, number> = {};
  for (const usage of usages) {
    const key = usage.resolved === false ? "unresolved" : String(usage.kind);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { name, file: file ?? null, components: matches.map(summary), counts, usages: window.take(usages) };
}

function matchComponents(components: Map<string, ComponentInfo>, name: string, file: string | undefined): ComponentInfo[] {
  return [...components.values()]
    .filter((component) => component.name === name && (!file || matchesFile(component.file, file)))
    .sort(byFileAndLine);
}

function summary(component: ComponentInfo) {
  return {
    name: component.name,
    kind: component.kind,
    framework: component.framework,
    file: component.file,
    line: component.line,
    endLine: component.endLine,
    isExported: component.isExported,
    ...(component.tagName ? { tagName: component.tagName } : {}),
    ...(component.props.length > 0 ? { props: component.props } : {}),
  };
}

// Render edges reached from `start`, level by level: "down" lists what it
// renders, "up" what renders it. An edge's depth is one more than the level
// of the component it starts from (the one nearer to `start`).
function renderLevels(
  renders: readonly RenderEdge[],
  start: string,
  direction: "up" | "down",
  maxDepth: number,
  component: (id: string) => ComponentInfo | undefined,
) {
  const levels = walkCalls(renders.map(({ parent, child, line }) => ({ caller: parent, callee: child, line })), [start], direction, maxDepth);
  const near = (edge: RenderEdge) => (direction === "down" ? edge.parent : edge.child);
  return renders
    .filter((edge) => levels.has(near(edge)) && levels.get(near(edge))! < maxDepth)
    .map((edge) => {
      const parent = component(edge.parent);
      const child = component(edge.child);
      return {
        depth: levels.get(near(edge))! + 1,
        parent: parent?.name ?? edge.parent,
        parentFile: parent?.file ?? null,
        line: edge.line,
        component: child?.name ?? edge.child,
        componentKind: child?.kind ?? null,
        componentFile: child?.file ?? null,
        props: edge.props,
      };
    })
    .sort((a, b) => a.depth - b.depth || String(a.parentFile).localeCompare(String(b.parentFile)) || (a.line ?? 0) - (b.line ?? 0));
}

function dedupe<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
