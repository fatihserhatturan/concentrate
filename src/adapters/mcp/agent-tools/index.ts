import { objectSchema } from "../args.js";
import type { McpTool } from "../tools.js";
import { componentTree, findComponentUsages } from "./components.js";
import { detectChanges, impactOf } from "./impact.js";
import { apiConsumers, routeDetails } from "./route.js";
import { getFileOutline, getSymbolSource } from "./source.js";

// Tools that answer an agent's question in one call ("what breaks if I change
// this?", "what does this endpoint do?") instead of a chain of lookups. Their
// results are capped at OUTPUT_BUDGET_CHARS (the server instructions say so
// once, not each description); each pages one primary list.

const maxDepth = { type: "number", description: "How many call levels to follow upward. Defaults to 5." };
const limit = (fallback: number) => ({ type: "number", description: `Maximum items per list. Defaults to ${fallback}.` });

export const agentToolDefinitions = [
  {
    name: "impact_of",
    description: `What a change to a function, method, class or file affects: transitive callers (with depth) and module-level callers, the routes and entrypoints that run them, the scripts, targets, services and jobs that start the file (runners), the components they implement and the components and pages that render those, the frontend calls reaching affected routes (apiConsumers), stores written with their readers and the components and pages those reach (storeComponents, storePages), and the data models, env vars and config used. A store's name or hook as symbol asks what reading it reaches. For a route, use route_details.`,
    inputSchema: objectSchema({
      symbol: { type: "string", description: "Function, method or class name (a class covers all its methods), or a store's name or hook." },
      file: { type: "string", description: "Scan-relative file or directory path, or a path suffix. Alone, covers every function in it; with symbol, narrows it." },
      maxDepth,
      limit: limit(50),
    }),
  },
  {
    name: "detect_changes",
    description: `Git working-tree changes against base (untracked included) on the graph: changed files, the declarations their lines touch, and the impact of the changed functions as in impact_of; files not in the graph go to unscannedFiles.`,
    inputSchema: objectSchema({
      base: { type: "string", description: "Revision to diff against, such as HEAD, main or HEAD~3. Defaults to HEAD." },
      maxDepth,
      limit: limit(50),
    }),
  },
  {
    name: "route_details",
    description: `Everything that runs for an HTTP route: handlers, middleware and lifecycle steps in order, the call chain below them (4 levels) with its data access, env vars and config, and its consumers (frontend calls) with the components and pages that make them. A GET also lists the UI pages at that path with the component each renders, its load functions, and the same chain and resources.`,
    inputSchema: objectSchema({
      method: { type: "string", description: "HTTP method, case-insensitive (GET, post, ...)." },
      path: { type: "string", description: "Route or page path, full or as declared." },
      limit: limit(5),
    }, ["method", "path"]),
  },
  {
    name: "api_consumers",
    description: `Client calls that reach a route: frontend (fetch, axios, ky, ofetch, useFetch, SWR, TanStack Query, Angular HttpClient, tRPC) and Go (net/http, resty), each with its route, calling function, file, line, client, resolved method and URL, and match kind (exact, parameter, catch-all). Filter by route (method, path, file, framework) or caller (file, client); unfiltered, lists every linked call.`,
    inputSchema: objectSchema({
      method: { type: "string", description: "Route method, case-insensitive (GET, post, query, mutation, ...)." },
      path: { type: "string", description: "Route path, full or as declared (/api/users/:id, post.byId)." },
      routeFile: { type: "string", description: "File or directory of the route declaration, or a path suffix." },
      framework: { type: "string", description: "Route framework, such as express-koa, nextjs, nuxt, sveltekit, trpc, gin or echo." },
      file: { type: "string", description: "File or directory of the calling code, or a path suffix." },
      client: { type: "string", description: "fetch, axios, ky, ofetch, nuxt, swr, tanstack-query, angular, trpc, net/http or resty." },
      limit: limit(50),
    }),
  },
  {
    name: "get_symbol_source",
    description: `Source of a declaration, read from disk at the line span of the last scan (at most 400 lines each).`,
    inputSchema: objectSchema({
      name: { type: "string", description: "Exact declaration name; Class.method selects one class's method." },
      file: { type: "string", description: "File or directory path (scan-relative), or a path suffix." },
      kind: { type: "string", description: "function, method, class, interface, type, enum or variable." },
      limit: limit(5),
    }, ["name"]),
  },
  {
    name: "get_file_outline",
    description: `One file's declarations in line order: imports, functions, classes with methods and fields, interfaces, types, enums, variables, routes and entrypoints.`,
    inputSchema: objectSchema({
      file: { type: "string", description: "Scan-relative file path or a unique path suffix." },
      limit: limit(200),
    }, ["file"]),
  },
  {
    name: "component_tree",
    description: `A UI component's tree, depth levels each way: what it renders and what renders it (props, line, an Astro island's client directive, an Angular template file), elements that resolved to no component (library components), its defining function or class, its hooks, and the contexts it reads (directly or through custom hooks).`,
    inputSchema: objectSchema({
      name: { type: "string", description: "Exact component name." },
      file: { type: "string", description: "File or directory path, or a path suffix, of the component." },
      depth: { type: "number", description: "How many render levels to follow each way. Defaults to 2, at most 10." },
      limit: limit(5),
    }, ["name"]),
  },
  {
    name: "find_component_usages",
    description: `Where a UI component is rendered: each site with the rendering component, file (an Angular component's template file), line, props and Astro client directive; for a context, the functions that read it. Library components such as Link come with resolved: false.`,
    inputSchema: objectSchema({
      name: { type: "string", description: "Exact component name." },
      file: { type: "string", description: "File or directory path, or a path suffix, of the component; leaves out unresolved elements." },
      limit: limit(50),
    }, ["name"]),
  },
];

export const agentTools: Record<string, McpTool> = {
  impact_of: { handler: impactOf, listKey: "callers", defaultLimit: 50 },
  detect_changes: { handler: detectChanges, listKey: "changedFiles", defaultLimit: 50 },
  route_details: { handler: routeDetails, listKey: "routes", defaultLimit: 5 },
  api_consumers: { handler: apiConsumers, listKey: "consumers", defaultLimit: 50 },
  get_symbol_source: { handler: getSymbolSource, listKey: "matches", defaultLimit: 5 },
  get_file_outline: { handler: getFileOutline, listKey: "outline", defaultLimit: 200 },
  component_tree: { handler: componentTree, listKey: "components", defaultLimit: 5 },
  find_component_usages: { handler: findComponentUsages, listKey: "usages", defaultLimit: 50 },
};
