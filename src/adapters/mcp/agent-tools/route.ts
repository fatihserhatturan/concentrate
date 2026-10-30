import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { requiredString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { describeFunction, functionResources, loadCallEdges, loadComponentFunctions, loadFunctions, mergeRows, summarizeTables, tableAccessColumns, walkCalls } from "./graph.js";

type Row = Record<string, unknown>;

const CHAIN_DEPTH = 4;

// route_details: everything that runs for one route, in one call. The method
// matches case-insensitively; the path matches the resolved full path or the
// path as written. A GET also lists the UI pages at that path, with the
// component each renders and what that component's code calls and uses.
export async function routeDetails(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const method = requiredString(args.method, "method");
  const routePath = requiredString(args.path, "path");

  const routes = (await engine.query(`
    MATCH (file:File)-[:DECLARES_ROUTE]->(route:Route)
    WHERE lower(route.method) = lower($method) AND (route.fullPath = $path OR route.path = $path)
    RETURN id(route) AS id, route.method AS method, route.path AS path, route.fullPath AS fullPath,
      route.framework AS framework, route.handlerName AS handlerName, file.relativePath AS file, route.line AS line
    ORDER BY file, line
    LIMIT ${window.fetch}
  `, { method, path: routePath }) as Row[]).slice(window.offset);
  const pages = method.toUpperCase() === "GET" ? await pageDetails(engine, routePath, window.limit) : [];
  if (routes.length === 0) {
    return pages.length > 0
      ? { method, path: routePath, routes: [], pages }
      : { method, path: routePath, routes: [], note: "No route or page matched. Use list_routes and list_pages to see the declared ones." };
  }

  const routeIds = routes.map((route) => String(route.id));
  const [functions, edges, handlers, steps, routeData, routeTables, routeEnv, routeConfig] = await Promise.all([
    loadFunctions(engine),
    loadCallEdges(engine),
    engine.query(`
      MATCH (route:Route)-[:ROUTE_HANDLED_BY]->(fn:Function)
      WHERE id(route) IN $ids
      RETURN id(route) AS route, id(fn) AS fn
    `, { ids: routeIds }),
    engine.query(`
      MATCH (route:Route)-[step:ROUTE_LIFECYCLE_STEP]->(fn:Function)
      WHERE id(route) IN $ids
      RETURN id(route) AS route, id(fn) AS fn, step.role AS role, step.scope AS scope, step.hook AS hook,
        step.orderIndex AS orderIndex
    `, { ids: routeIds }),
    engine.query(`
      MATCH (route:Route)-[rel:ACCESSES_DATA_ROUTE]->(model:DataModel)
      WHERE id(route) IN $ids
      RETURN id(route) AS route, model.name AS model, model.library AS library, rel.operation AS operation,
        rel.line AS line, rel.expression AS expression
    `, { ids: routeIds }),
    engine.query(`
      MATCH (route:Route)-[rel:READS_ROUTE|WRITES_ROUTE]->(table:Table)
      WHERE id(route) IN $ids
      RETURN id(route) AS route, ${tableAccessColumns}
    `, { ids: routeIds }),
    engine.query(`
      MATCH (route:Route)-[rel:USES_ENV_ROUTE]->(env:EnvVar)
      WHERE id(route) IN $ids
      RETURN id(route) AS route, env.name AS name, rel.access AS access, rel.line AS line
    `, { ids: routeIds }),
    engine.query(`
      MATCH (route:Route)-[rel:CONSUMES_CONFIG_ROUTE]->(config:ConfigValue)
      WHERE id(route) IN $ids
      RETURN id(route) AS route, config.name AS name, rel.localName AS localName
    `, { ids: routeIds }),
  ]) as [Awaited<ReturnType<typeof loadFunctions>>, Awaited<ReturnType<typeof loadCallEdges>>, Row[], Row[], Row[], Row[], Row[], Row[]];
  const describe = (id: unknown) => describeFunction(functions.get(String(id)), String(id));

  const details = [];
  for (const route of routes) {
    const ofRoute = (rows: Row[]) => rows.filter((row) => row.route === route.id).map(({ route: _route, ...row }) => row);
    const routeSteps = ofRoute(steps).sort((a, b) => (Number(a.orderIndex) || 0) - (Number(b.orderIndex) || 0));
    // ROUTE_HANDLED_BY also links route-level middleware; those are listed under lifecycle only.
    const middleware = new Set(routeSteps.filter((step) => step.role !== "handler").map((step) => String(step.fn)));
    const handlerIds = [...new Set(ofRoute(handlers).map((row) => String(row.fn)))].filter((id) => !middleware.has(id));
    const roots = [...new Set([...handlerIds, ...routeSteps.map((step) => String(step.fn))])];

    // Downstream calls from the handlers and lifecycle steps, as caller -> callee edges.
    const depth = walkCalls(edges, roots, "down", CHAIN_DEPTH);
    const callChain = downstreamCalls(edges, depth, describe);

    const resources = await functionResources(engine, [...depth.keys()]);
    // Uses by the route itself (fn unset) and by functions in its chain.
    const usedBy = (row: Row) => row.fn === undefined
      ? { route: true }
      : { function: describe(row.fn).name, functionFile: describe(row.fn).file };
    const uses = (routeRows: Row[], functionRows: Row[]) => mergeRows([...ofRoute(routeRows), ...functionRows], ["fn"], "usedBy", usedBy);

    const { id: _id, ...info } = route;
    details.push({
      ...info,
      handlers: handlerIds.map(describe),
      lifecycle: routeSteps.map(({ fn, ...step }) => ({ ...step, ...describe(fn) })),
      callChain: callChain.slice(0, 100),
      dataAccess: uses(routeData, resources.dataAccess),
      tables: summarizeTables([...ofRoute(routeTables), ...resources.tables], usedBy),
      envVars: uses(routeEnv, resources.envVars),
      config: uses(routeConfig, resources.config),
    });
  }
  return { method, path: routePath, routes: details, ...(pages.length > 0 ? { pages } : {}) };
}

// The pages at `pagePath` (full path or as written), each with its
// component and the downstream calls, data access, env vars and config of
// the functions that implement the component.
async function pageDetails(engine: IQueryEngine, pagePath: string, limit: number) {
  const pages = await engine.query(`
    MATCH (file:File)-[:DECLARES_PAGE]->(page:Page)
    WHERE page.fullPath = $path OR page.path = $path
    OPTIONAL MATCH (page)-[:PAGE_RENDERS]->(component:Component)
    RETURN id(page) AS id, page.path AS path, page.fullPath AS fullPath, page.framework AS framework,
      page.router AS router, page.kind AS kind, page.slot AS slot, file.relativePath AS file, page.line AS line,
      id(component) AS component, component.name AS componentName
    ORDER BY file, line
    LIMIT ${limit}
  `, { path: pagePath }) as Row[];
  if (pages.length === 0) return [];

  const componentIds = [...new Set(pages.flatMap((page) => (page.component == null ? [] : [String(page.component)])))];
  const [functions, edges, implementations, componentFiles] = await Promise.all([
    loadFunctions(engine),
    loadCallEdges(engine),
    loadComponentFunctions(engine),
    engine.query(`
      MATCH (file:File)-[:DECLARES_COMPONENT]->(component:Component)
      WHERE id(component) IN $ids
      RETURN id(component) AS id, file.relativePath AS file, component.line AS line
    `, { ids: componentIds }),
  ]) as [Awaited<ReturnType<typeof loadFunctions>>, Awaited<ReturnType<typeof loadCallEdges>>, Awaited<ReturnType<typeof loadComponentFunctions>>, Row[]];
  const describe = (id: unknown) => describeFunction(functions.get(String(id)), String(id));

  const details = [];
  for (const { id: _id, component, componentName, ...page } of pages) {
    const location = componentFiles.find((row) => row.id === component);
    const roots = implementations.filter((row) => row.component === component).map((row) => row.fn);
    const depth = walkCalls(edges, roots, "down", CHAIN_DEPTH);
    const resources = await functionResources(engine, [...depth.keys()]);
    const usedBy = (row: Row) => ({ function: describe(row.fn).name, functionFile: describe(row.fn).file });
    details.push({
      ...page,
      component: component == null ? null : { name: componentName, file: location?.file ?? null, line: location?.line ?? null },
      callChain: downstreamCalls(edges, depth, describe).slice(0, 100),
      dataAccess: mergeRows(resources.dataAccess, ["fn"], "usedBy", usedBy),
      tables: summarizeTables(resources.tables, usedBy),
      envVars: mergeRows(resources.envVars, ["fn"], "usedBy", usedBy),
      config: mergeRows(resources.config, ["fn"], "usedBy", usedBy),
    });
  }
  return details;
}

// The caller -> callee edges among the functions `depth` reached, shallowest first.
function downstreamCalls(
  edges: Awaited<ReturnType<typeof loadCallEdges>>,
  depth: Map<string, number>,
  describe: (id: unknown) => ReturnType<typeof describeFunction>,
) {
  return edges
    .filter((edge) => depth.has(edge.caller) && depth.get(edge.caller)! < CHAIN_DEPTH && depth.has(edge.callee))
    .map((edge) => ({
      depth: depth.get(edge.caller)! + 1,
      caller: describe(edge.caller).name,
      callerFile: describe(edge.caller).file,
      line: edge.line,
      callee: describe(edge.callee).name,
      calleeClass: describe(edge.callee).className,
      calleeFile: describe(edge.callee).file,
    }))
    .sort((a, b) => a.depth - b.depth || String(a.callerFile).localeCompare(String(b.callerFile)) || (a.line ?? 0) - (b.line ?? 0));
}
