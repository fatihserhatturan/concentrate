import { objectSchema } from "../args.js";
import { OUTPUT_BUDGET_CHARS } from "../budget.js";
import type { McpTool } from "../tools.js";
import { componentTree, findComponentUsages } from "./components.js";
import { detectChanges, impactOf } from "./impact.js";
import { apiConsumers, routeDetails } from "./route.js";
import { getFileOutline, getSymbolSource } from "./source.js";

// Tools that answer an agent's question in one call ("what breaks if I change
// this?", "what does this endpoint do?") instead of a chain of lookups. Their
// results are capped at OUTPUT_BUDGET_CHARS; each pages one primary list.

const budgetNote = `Results over ${OUTPUT_BUDGET_CHARS} characters are shortened: the paged list ends early with page.nextCursor, and \`truncated\` lists how many items each other list lost.`;

const maxDepth = { type: "number", description: "How many call levels to follow upward. Defaults to 5." };
const limit = (fallback: number) => ({ type: "number", description: `Maximum items per list. Defaults to ${fallback}.` });

export const agentToolDefinitions = [
  {
    name: "impact_of",
    description: `What is affected if a function, method, class or file changes: transitive callers with their call depth, module-level callers, the routes and entrypoints that run any of them, the UI components they implement, the components that render those and the pages that render any of them, the frontend calls that reach the affected routes (apiConsumers) with the components and pages whose code makes them, and the data models, env vars and config the changed code uses. For a route, use route_details instead. ${budgetNote}`,
    inputSchema: objectSchema({
      symbol: { type: "string", description: "Function, method or class name (a class covers all its methods)." },
      file: { type: "string", description: "Scan-relative file path or path suffix. Alone, covers every function in the file; with symbol, narrows it." },
      maxDepth,
      limit: limit(50),
    }),
  },
  {
    name: "detect_changes",
    description: `Map the git working tree's changes (against base, including untracked files) onto the graph: changed files, the declarations their changed lines touch, and the impact of the changed functions as in impact_of. Changed files missing from the graph are listed under unscannedFiles. ${budgetNote}`,
    inputSchema: objectSchema({
      base: { type: "string", description: "Revision to diff against, such as HEAD, main or HEAD~3. Defaults to HEAD." },
      maxDepth,
      limit: limit(50),
    }),
  },
  {
    name: "route_details",
    description: `Everything that runs for an HTTP route: handlers, middleware and lifecycle steps in order, the downstream call chain (up to 4 levels), and the data access, env vars and config of the route and that chain. Each route lists its consumers (the frontend calls that reach it) with the components and pages whose code makes them. A GET also lists the UI pages at that path (Next.js, React Router, TanStack Router, Vue Router) with the component each renders and the same chain and resources for that component's code. ${budgetNote}`,
    inputSchema: objectSchema({
      method: { type: "string", description: "HTTP method, case-insensitive (GET, post, ...)." },
      path: { type: "string", description: "Route or page path, matched against the resolved full path or the path as declared." },
      limit: limit(5),
    }, ["method", "path"]),
  },
  {
    name: "api_consumers",
    description: `The frontend calls that reach a route (fetch, axios, ky, ofetch, SWR, TanStack Query and tRPC calls linked by URL or procedure path), each with its route, the calling function or file and line, the client, the method and URL as resolved, and the match kind (exact, parameter or catch-all). Filter by the route's method, path, file or framework, or by the calling file or client; with no filter, lists every linked call. ${budgetNote}`,
    inputSchema: objectSchema({
      method: { type: "string", description: "Optional route method, case-insensitive (GET, post, query, mutation, ...)." },
      path: { type: "string", description: "Optional route path, matched against the resolved full path or the path as declared (/api/users/:id, post.byId)." },
      routeFile: { type: "string", description: "Optional scan-relative file of the route declaration." },
      framework: { type: "string", description: "Optional route framework, such as express-koa, nextjs or trpc." },
      file: { type: "string", description: "Optional scan-relative file of the calling code." },
      client: { type: "string", description: "Optional client: fetch, axios, ky, ofetch, swr, tanstack-query or trpc." },
      limit: limit(50),
    }),
  },
  {
    name: "get_symbol_source",
    description: `Source code of a declaration, read from disk with the line span from the last scan (at most 400 lines each). ${budgetNote}`,
    inputSchema: objectSchema({
      name: { type: "string", description: "Exact declaration name; Class.method selects one class's method." },
      file: { type: "string", description: "Optional scan-relative file path or path suffix." },
      kind: { type: "string", description: "Optional kind: function, method, class, interface, type, enum or variable." },
      limit: limit(5),
    }, ["name"]),
  },
  {
    name: "get_file_outline",
    description: `Declarations of one file from the graph in line order: imports, functions, classes with their methods and fields, interfaces, types, enums, variables, routes and entrypoints. ${budgetNote}`,
    inputSchema: objectSchema({
      file: { type: "string", description: "Scan-relative file path or a unique path suffix." },
      limit: limit(200),
    }, ["file"]),
  },
  {
    name: "component_tree",
    description: `A UI component's tree: what it renders and what renders it (each with the props passed and the render line, up to depth levels), elements that resolved to no component (library components), the function or class that defines it, its hooks, and the contexts it reads directly or through custom hooks. ${budgetNote}`,
    inputSchema: objectSchema({
      name: { type: "string", description: "Exact component name." },
      file: { type: "string", description: "Optional scan-relative file path or path suffix of the component." },
      depth: { type: "number", description: "How many render levels to follow each way. Defaults to 2, at most 10." },
      limit: limit(5),
    }, ["name"]),
  },
  {
    name: "find_component_usages",
    description: `Where a UI component is rendered: each render site with the rendering component, file, line and props passed; for a context, also the functions that read it (useContext / use). Elements of that name that resolved to no component (library components such as Link) are listed with resolved: false. ${budgetNote}`,
    inputSchema: objectSchema({
      name: { type: "string", description: "Exact component name." },
      file: { type: "string", description: "Optional scan-relative file path or path suffix of the component; leaves out unresolved elements." },
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
