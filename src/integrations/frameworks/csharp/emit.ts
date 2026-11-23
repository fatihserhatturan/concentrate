import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";

// Route and EntryPoint nodes the one way every language creates them (same shapes as Java's `addJavaRoute` and
// `addJavaEntryPoint`, so `list_routes` and the entrypoint queries need nothing C#-specific).

function uniqueId(graph: IGraphContributor, base: string): string {
  let id = base;
  for (let n = 2; graph.node(id); n += 1) id = `${base}#${n}`;
  return id;
}

/**
 * Joins route path parts: `/api` + `users/{id}` is `/api/users/{id}`. Empty, undefined, `""` and `/` parts add
 * nothing; slashes are collapsed, trailing slashes dropped; the result always starts with `/`.
 */
export function joinRoutePath(...parts: ReadonlyArray<string | null | undefined>): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const segment of (part ?? "").split("/")) if (segment !== "") segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export type CSharpRouteInput = {
  fileId: string;
  /** Upper case HTTP method (`GET`); `ALL` for any. */
  method: string;
  /** The full, joined path; null when only an expression is known (then give `pathExpression`). */
  path: string | null;
  pathExpression?: string | null;
  /** Shown by `list_routes` `framework`: `aspnet-mvc`, `aspnet-minimal`, `azure-functions`. */
  framework: string;
  line: number;
  /** The handler Function node (a ROUTE_HANDLED_BY edge is made); its name becomes `handlerName`. */
  handler?: GraphNode | null;
  /** The handler's name when no node is known (a lambda: `<lambda>`). */
  handlerName?: string | null;
};

/**
 * Adds a Route: properties method, path and fullPath (both the joined path), pathExpression (null when `path` is
 * known), receiverName (null), line, framework, handlerName; `File -DECLARES_ROUTE-> Route` and, with a handler,
 * `Route -ROUTE_HANDLED_BY-> Function`. Returns the node.
 */
export function addCSharpRoute(graph: IGraphContributor, input: CSharpRouteInput): GraphNode {
  const handlerName = input.handler ? String(input.handler.properties.name) : input.handlerName ?? null;
  const node: GraphNode = {
    id: uniqueId(graph, `${input.fileId}:route:${input.line}:0:${input.method}:${input.path ?? input.pathExpression ?? "<none>"}`),
    label: "Route",
    properties: {
      method: input.method,
      path: input.path,
      fullPath: input.path,
      pathExpression: input.path === null ? input.pathExpression ?? null : null,
      receiverName: null,
      line: input.line,
      framework: input.framework,
      handlerName,
    },
  };
  graph.addNode(node);
  graph.addRelationship({ from: input.fileId, to: node.id, type: "DECLARES_ROUTE", properties: {} });
  if (input.handler) graph.addRelationship({ from: node.id, to: input.handler.id, type: "ROUTE_HANDLED_BY", properties: {} });
  return node;
}

export type CSharpEntryPointInput = {
  fileId: string;
  /** `main` (csharp.entrypoints owns it), `grpc`, `signalr`, `hosted-service`, `function`, `command`... */
  kind: string;
  /** What triggers it (a service name, a cron expression, a command name); null when nothing does. */
  trigger?: string | null;
  line: number;
  handler: GraphNode;
  /** Library label: `grpc-dotnet`, `signalr`, `hosted-service`, `azure-functions`, `system-commandline`. */
  library: string;
};

/**
 * Adds an EntryPoint: properties kind, trigger, receiverName (null), library, line, handlerName;
 * `File -DECLARES_ENTRYPOINT-> EntryPoint` and `EntryPoint -ENTRYPOINT_HANDLED_BY-> Function`. Returns the node.
 */
export function addCSharpEntryPoint(graph: IGraphContributor, input: CSharpEntryPointInput): GraphNode {
  const trigger = input.trigger ?? null;
  const node: GraphNode = {
    id: uniqueId(graph, `${input.fileId}:entrypoint:${input.line}:0:${input.kind}:${trigger ?? "<none>"}`),
    label: "EntryPoint",
    properties: {
      kind: input.kind,
      trigger,
      receiverName: null,
      library: input.library,
      line: input.line,
      handlerName: String(input.handler.properties.name),
    },
  };
  graph.addNode(node);
  graph.addRelationship({ from: input.fileId, to: node.id, type: "DECLARES_ENTRYPOINT", properties: {} });
  graph.addRelationship({ from: node.id, to: input.handler.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
  return node;
}
