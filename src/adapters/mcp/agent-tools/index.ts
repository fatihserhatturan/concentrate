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
const limit = (fallback: number) => ({ type: "number", description: `Items per list. Default ${fallback}.` });

export const agentToolDefinitions = [
  {
    name: "impact_of",
    description: `What a change to a function, method, class or file affects: transitive callers (with depth), module-level callers, the routes and entrypoints that run them, the scripts, targets, services and jobs starting the file (runners), the components implementing them and the components and pages rendering those, frontend calls reaching affected routes (apiConsumers), stores written with their readers and the components and pages those reach (storeComponents, storePages), and data models, env vars and config used. A store's name or hook as symbol: what reading it reaches; a style (.btn, --color) or CSS file: its users.`,
    inputSchema: objectSchema({
      symbol: { type: "string", description: "Function, method or class name (a class covers all its methods), a store's name or hook, or .class, #id, --property." },
      file: { type: "string", description: "File or directory path, or a path suffix. Alone, covers every function in it; with symbol, narrows it." },
      maxDepth,
      limit: limit(50),
    }),
  },
  {
    name: "detect_changes",
    description: `Git working-tree changes against base (untracked included): changed files, the declarations their lines touch, and the impact of changed functions as in impact_of; files not in the graph go to unscannedFiles.`,
    inputSchema: objectSchema({
      base: { type: "string", description: "Revision to diff against, such as HEAD, main or HEAD~3. Defaults to HEAD." },
      maxDepth,
      limit: limit(50),
    }),
  },
  {
    name: "route_details",
    description: `What runs for an HTTP route: handlers, middleware and lifecycle steps in order, the call chain below (4 levels) with data access, env vars and config, and its frontend consumers (components, pages). A GET also lists the UI pages at that path with components, load functions, chain and resources.`,
    inputSchema: objectSchema({
      method: { type: "string", description: "HTTP method, case-insensitive (GET, post, ...)." },
      path: { type: "string", description: "Route or page path, full or as declared." },
      limit: limit(5),
    }, ["method", "path"]),
  },
  {
    name: "api_consumers",
    description: `Client calls reaching a route: frontend (fetch, axios, ky, useFetch, SWR, TanStack Query, HttpClient, tRPC) and Go (net/http, resty), each with route, caller, file, line, client, resolved method, URL and match kind (exact, parameter, catch-all). Unfiltered, every linked call.`,
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
    description: `Source of a declaration, read from disk at its last-scan line span (at most 400 lines each).`,
    inputSchema: objectSchema({
      name: { type: "string", description: "Exact declaration name; Class.method selects one class's method." },
      file: { type: "string", description: "File or directory path (scan-relative), or a path suffix." },
      kind: { type: "string", description: "function, method, class, interface, type, enum or variable." },
      limit: limit(5),
    }, ["name"]),
  },
  {
    name: "get_file_outline",
    description: `One file's declarations in line order: imports, functions, classes (methods, fields), interfaces, types, enums, variables, routes, entrypoints.`,
    inputSchema: objectSchema({
      file: { type: "string", description: "Scan-relative file path or a unique path suffix." },
      limit: limit(200),
    }, ["file"]),
  },
  {
    name: "component_tree",
    description: `A UI component's tree, depth levels each way: what it renders and what renders it (props, line, Astro client directive, Angular template file), unresolved (library) elements, its defining function or class, hooks and the contexts it reads.`,
    inputSchema: objectSchema({
      name: { type: "string", description: "Exact component name." },
      file: { type: "string", description: "File or directory path, or a path suffix, of the component." },
      depth: { type: "number", description: "How many render levels to follow each way. Defaults to 2, at most 10." },
      limit: limit(5),
    }, ["name"]),
  },
  {
    name: "find_component_usages",
    description: `Where a UI component is rendered: each site with rendering component, file (Angular: template file), line, props and Astro client directive; for a context, its readers. Library components (Link) have resolved: false.`,
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
