import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalString, requiredString } from "../args.js";
import type { PageWindow } from "../paging.js";
import { apiConsumers as loadApiConsumers, routeDetails as loadRouteDetails } from "../../../core/queries/routes.js";

// route_details: everything that runs for one route, in one call. The
// computation lives in core/queries/routes.ts; this handler parses the
// arguments and words the empty result.
export async function routeDetails(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const method = requiredString(args.method, "method");
  const routePath = requiredString(args.path, "path");
  const { routes, pages } = await loadRouteDetails(engine, { method, path: routePath, window });
  if (routes.length === 0) {
    return pages.length > 0
      ? { method, path: routePath, routes: [], pages }
      : { method, path: routePath, routes: [], note: "No route or page matched. Use list_routes and list_pages to see the declared ones." };
  }
  return { method, path: routePath, routes, ...(pages.length > 0 ? { pages } : {}) };
}

// api_consumers: the frontend calls that reach a route, see core/queries/routes.ts.
export async function apiConsumers(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const method = optionalString(args.method);
  const routePath = optionalString(args.path);
  const routeFile = optionalString(args.routeFile);
  const framework = optionalString(args.framework);
  const file = optionalString(args.file);
  const client = optionalString(args.client);
  const rows = await loadApiConsumers(engine, { method, path: routePath, routeFile, framework, file, client });
  return {
    query: { method: method ?? null, path: routePath ?? null, routeFile: routeFile ?? null, framework: framework ?? null, file: file ?? null, client: client ?? null, limit: window.limit },
    consumers: window.take(rows),
    ...(rows.length === 0 ? { note: "No call reaches a matching route. Use list_routes to see the declared routes; unresolved or dynamic URLs are not linked." } : {}),
  };
}
