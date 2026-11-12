import path from "node:path";
import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../../core/contracts/semantic-contributor.js";
import { ENV_VALUE_FILES, readEnvFiles, type EnvFiles } from "../env-files.js";
import { createVariableResolver } from "./variable-resolver.js";

// REQUESTS: an outbound HTTP call (`Call.httpMethod` / `httpUrl`, set by the
// http-clients and trpc parse plugins) to the Route it reaches, matched on the method
// and the route's full path. Only same-origin paths (`/api/users`) are
// matched. A `${…}` segment of a template URL matches a route parameter
// (`:id`, `[id]`, `{id}`, Flask and Django `<id>` / `<int:id>`; `<path:p>` is a catch-all); a literal segment matches the same literal or a
// parameter; a catch-all (`*`, `[...slug]`, `[[...slug]]`, `:path*`) takes
// the rest. Of the routes that match, the most specific one wins (literal
// segments over parameters over catch-alls); a tie between routes leaves the
// call unlinked, unless the two routes differ only by a trailing slash
// (`/users` and `/users/`), where the one written like the URL wins, as does a URL with a partly dynamic segment (`/u/${id}.json`).
// A call with `httpUrlAlternatives` (a URL variable assigned several values)
// is matched once per URL and linked to each route one of them reaches.
// `match` is `exact` when every segment matched a literal, `catch-all` when a
// catch-all took the end, otherwise `parameter`. Routes of method ALL match
// any method; middleware mounts (USE) match none. A tRPC call (`httpClient`
// `trpc`) links to the procedure Route with the same method and dotted full
// path (`match` `exact`); tRPC routes take no part in URL matching.
//
// Before matching, each call's URL is resolved in place: a call on a
// receiver (`api.get(…)`, `httpReceiver`) takes the client and base URL of
// the instance variable the receiver resolves to, in the file or through
// imports, and loses its request otherwise; `${NAME}` placeholders become the
// string constants they name (same file or imported; a template constant is
// resolved in turn); the base is joined to a relative URL; and a local origin
// (`http://localhost:3000`, `127.0.0.1`, `0.0.0.0`), or one of the scan's
// `apiOrigins` (the scheme, host and port of each; `--api-origin`), is
// dropped, so the URL becomes a path. A URL that is a single unresolved variable is left null.
//
// Env reads (`${process.env.API_URL}`, `import.meta.env.VITE_API`, also
// through a constant) take their value from the `.env*` files the scan
// discovered (gitignored ones are not), nearest directory first, in the order
// of `ENV_VALUE_FILES`, or else from a literal fallback (`?? "http://localhost:4000"`).
// Only values that are URLs or paths are used, and a URL resolved through env
// is kept only when it ends up a path; otherwise it stays as written.

export type RouteSegment = { kind: "literal"; value: string } | { kind: "param" } | { kind: "catch-all"; optional: boolean };
type RouteEntry = { id: string; method: string; segments: RouteSegment[]; trailingSlash: boolean };

export const httpRequestsContributor: ISemanticContributor = {
  async contribute(graph, rootPath, _report, files, settings) {
    const origins = (settings?.apiOrigins ?? []).flatMap((origin) => {
      try {
        return [new URL(origin).origin.toLowerCase()];
      } catch {
        return [];
      }
    });
    resolveRequestUrls(graph.nodes, graph.relationships, await readEnvFiles(rootPath, files), origins);
    const routes: RouteEntry[] = [];
    // `METHOD:fullPath` → tRPC procedure routes.
    const trpcRoutes = new Map<string, string[]>();
    for (const node of graph.nodes) {
      if (node.label !== "Route" || typeof node.properties.fullPath !== "string") continue;
      if (node.properties.framework === "trpc") {
        const key = `${node.properties.method}:${node.properties.fullPath}`;
        trpcRoutes.set(key, [...(trpcRoutes.get(key) ?? []), node.id]);
        continue;
      }
      const method = String(node.properties.method).toUpperCase();
      if (method === "USE") continue;
      routes.push({ id: node.id, method, segments: routeSegments(node.properties.fullPath), trailingSlash: node.properties.fullPath.length > 1 && node.properties.fullPath.endsWith("/") });
    }
    const added: GraphRelationship[] = [];
    for (const call of graph.nodes) {
      if (call.label !== "Call" || call.properties.httpClient !== "trpc") continue;
      const { httpMethod: method, httpUrl: url } = call.properties;
      const ids = trpcRoutes.get(`${method}:${url}`);
      if (ids?.length === 1) added.push({ from: call.id, to: ids[0]!, type: "REQUESTS", properties: { method, url, match: "exact" } });
    }
    if (routes.length === 0) {
      for (const rel of added) graph.addRelationship(rel);
      return;
    }

    for (const call of graph.nodes) {
      if (call.properties.httpClient === "trpc") continue;
      const linked = new Set<string>();
      for (const request of requestsOf(call)) {
        let best: { route: RouteEntry; score: number; match: string } | null = null;
        let tied: RouteEntry[] = [];
        for (const route of routes) {
          if (route.method !== request.method && route.method !== "ALL") continue;
          const matched = matchSegments(request.segments, route.segments);
          if (!matched) continue;
          if (!best || matched.score > best.score) {
            best = { route, ...matched };
            tied = [route];
          } else if (matched.score === best.score) {
            tied.push(route);
          }
        }
        // Routes that differ only by a trailing slash (gin's `/users` and
        // `/users/`): the one written like the URL.
        if (best && tied.length > 1) {
          const slash = request.url.length > 1 && request.url.endsWith("/");
          const same = tied.filter((route) => route.trailingSlash === slash);
          if (same.length === 1 && tied.length === 2 && tied[0]!.trailingSlash !== tied[1]!.trailingSlash) {
            best = { ...best, route: same[0]! };
            tied = [same[0]!];
          }
        }
        // Several programs of one repository registering the same path (the
        // cpp-httplib examples): the route in the file of the call is the
        // one it reaches.
        if (best && tied.length > 1) {
          const callFile = fileOfNodeId(call.id);
          const sameFile = callFile === null ? [] : tied.filter((route) => fileOfNodeId(route.id) === callFile);
          if (sameFile.length === 1) {
            best = { ...best, route: sameFile[0]! };
            tied = [sameFile[0]!];
          }
        }
        if (!best || tied.length > 1 || linked.has(best.route.id)) continue;
        linked.add(best.route.id);
        added.push({
          from: call.id,
          to: best.route.id,
          type: "REQUESTS",
          properties: { method: request.method, url: request.url, match: best.match },
        });
      }
    }
    for (const rel of added) graph.addRelationship(rel);
  },
};

// `file:<path>:function:…`, `file:<path>:route:…`: the file a node id belongs to.
function fileOfNodeId(id: string): string | null {
  return /^file:(.+?):(?:function|route|call)\b/u.exec(id)?.[1] ?? null;
}

function resolveRequestUrls(nodes: GraphNode[], relationships: GraphRelationship[], env: EnvFiles, origins: readonly string[]): void {
  const calls = nodes.filter((node) => node.label === "Call" && (node.properties.httpMethod !== undefined || node.properties.httpReceiver !== undefined));
  if (calls.length === 0) return;
  const { nodeById, fileByVariableId, variableOf, fileOfCall } = createVariableResolver(nodes, relationships);
  const envValue = (name: string, fileId: string): string | undefined => {
    const relativePath = nodeById.get(fileId)?.properties.relativePath;
    if (typeof relativePath !== "string") return undefined;
    let directory = path.posix.dirname(relativePath);
    for (;;) {
      const byName = env.get(directory === "." ? "" : directory);
      for (const file of ENV_VALUE_FILES) {
        const value = byName?.get(file)?.get(name);
        if (value !== undefined) return value;
      }
      if (directory === "." || directory === "") return undefined;
      directory = path.posix.dirname(directory);
    }
  };
  // Whether an env read was substituted.
  let usedEnv = false;
  const substitute = (text: string, fileId: string, depth = 0): string => text.replace(/\$\{([^{}]*)\}/gu, (placeholder, expression: string) => {
    const name = expression.trim();
    if (/^[A-Za-z_$][\w$]*$/u.test(name)) {
      const variable = variableOf(name, fileId);
      const value = variable?.properties.stringValue;
      if (typeof value === "string") return value;
      const template = variable?.properties.stringTemplate;
      const variableFileId = variable ? fileByVariableId.get(variable.id) : undefined;
      return typeof template === "string" && variableFileId && depth < 5 ? substitute(template, variableFileId, depth + 1) : placeholder;
    }
    const read = /^(?:process|import\.meta)\.env\.([A-Za-z_]\w*)(?:\s*(?:\?\?|\|\|)\s*(["'])(.*)\2)?$/su.exec(name);
    const value = read ? envValue(read[1]!, fileId) ?? read[3] : undefined;
    if (value === undefined || !/^(?:https?:\/\/|\/)/u.test(value)) return placeholder;
    usedEnv = true;
    return value;
  });

  for (const call of calls) {
    const fileId = fileOfCall(call.id);
    usedEnv = false;
    let base: string | null = null;
    const receiver = call.properties.httpReceiver;
    if (typeof receiver === "string") {
      const instance = fileId ? variableOf(receiver, fileId) : undefined;
      if (typeof instance?.properties.httpClient !== "string") {
        delete call.properties.httpReceiver;
        delete call.properties.httpMethod;
        delete call.properties.httpUrl;
        continue;
      }
      call.properties.httpClient = instance.properties.httpClient;
      const instanceBase = instance.properties.httpBaseUrl;
      const instanceFileId = fileByVariableId.get(instance.id);
      if (typeof instanceBase === "string") base = instanceFileId ? substitute(instanceBase, instanceFileId) : instanceBase;
    }
    const written = call.properties.httpUrl;
    if (typeof written !== "string" || !fileId) continue;
    const resolve = (text: string): string | null => {
      usedEnv = false;
      const url = substitute(text, fileId);
      const resolved = /^\$\{[^}]*\}$/u.test(url) && base === null ? null : localPath(joinBaseUrl(base, url), origins);
      return usedEnv && !resolved?.startsWith("/") ? text : resolved;
    };
    call.properties.httpUrl = resolve(written);
    const alternatives = call.properties.httpUrlAlternatives;
    if (typeof alternatives === "string") {
      call.properties.httpUrlAlternatives = JSON.stringify((JSON.parse(alternatives) as string[]).map(resolve));
    }
  }
}

function joinBaseUrl(base: string | null, url: string): string {
  if (base === null || /^[a-z][a-z\d+.-]*:\/\//iu.test(url)) return url;
  if (url === "") return base;
  return `${base.replace(/\/+$/u, "")}/${url.replace(/^\/+/u, "")}`;
}

function localPath(url: string, origins: readonly string[]): string {
  const match = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?=[/]|$)/iu.exec(url);
  if (match) return url.slice(match[0].length) || "/";
  const origin = origins.find((candidate) => url.toLowerCase().startsWith(candidate) && /^(?:[/]|$)/u.test(url.slice(candidate.length)));
  return origin ? url.slice(origin.length) || "/" : url;
}

type Request = { method: string; url: string; segments: Array<string | null> };

// The requests of an HTTP call, one per URL (`httpUrl`, then each of
// `httpUrlAlternatives`): its method and URL segments, `null` for a dynamic
// segment.
function requestsOf(call: GraphNode): Request[] {
  const { httpMethod, httpUrl, httpUrlAlternatives } = call.properties;
  if (call.label !== "Call" || typeof httpMethod !== "string") return [];
  const alternatives = typeof httpUrlAlternatives === "string" ? JSON.parse(httpUrlAlternatives) as unknown[] : [];
  return [httpUrl, ...alternatives].flatMap((url) => {
    const request = typeof url === "string" ? requestOf(httpMethod, url) : null;
    return request ? [request] : [];
  });
}

function requestOf(method: string, url: string): Request | null {
  if (!url.startsWith("/")) return null;
  const segments: Array<string | null> = [];
  for (const segment of url.split("/").filter(Boolean)) {
    if (/^\$\{[^}]*\}$/u.test(segment)) segments.push(null);
    else if (segment.includes("${")) return null;
    else segments.push(decodeSegment(segment));
  }
  return { method, url, segments };
}

export function routeSegments(fullPath: string): RouteSegment[] {
  return fullPath.split("/").filter(Boolean).map((segment): RouteSegment => {
    if (/^\[\[\.\.\..+\]\]$/u.test(segment)) return { kind: "catch-all", optional: true };
    if (/^\[\.\.\..+\]$/u.test(segment) || segment === "*" || /^:[^/]+[*+]$/u.test(segment) || segment === "(.*)") {
      return { kind: "catch-all", optional: segment.endsWith("*") && segment !== "*" };
    }
    if (/^<path:[^/>]+>$/u.test(segment)) return { kind: "catch-all", optional: false };
    if (/^(?::[^/]+|\[[^/]+\]|\{[^/]+\}|<[^/]+>)$/u.test(segment)) return { kind: "param" };
    return { kind: "literal", value: decodeSegment(segment) };
  });
}

// Segment scores: 3 for a literal, 2 for a parameter, 1 for a catch-all.
export function matchSegments(url: ReadonlyArray<string | null>, route: readonly RouteSegment[]): { score: number; match: string } | null {
  let score = 0;
  let exact = true;
  for (let index = 0; index < route.length; index++) {
    const segment = route[index]!;
    if (segment.kind === "catch-all") {
      if (index === url.length && !segment.optional) return null;
      return index === route.length - 1 ? { score: score + 1, match: "catch-all" } : null;
    }
    if (index >= url.length) return null;
    const value = url[index];
    if (segment.kind === "param") {
      score += 2;
      exact = false;
    } else if (value === segment.value) {
      score += 3;
    } else {
      return null;
    }
  }
  return url.length === route.length ? { score, match: exact ? "exact" : "parameter" } : null;
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
