import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../../core/contracts/semantic-contributor.js";
import { resolveDeclaration } from "../../../../core/scan/resolution/call-targets.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile } from "../../../../core/scan/resolution/indexes.js";

// REQUESTS: an outbound HTTP call (`Call.httpMethod` / `httpUrl`, set by the
// http-clients parse plugin) to the Route it reaches, matched on the method
// and the route's full path. Only same-origin paths (`/api/users`) are
// matched. A `${…}` segment of a template URL matches a route parameter
// (`:id`, `[id]`, `{id}`); a literal segment matches the same literal or a
// parameter; a catch-all (`*`, `[...slug]`, `[[...slug]]`, `:path*`) takes
// the rest. Of the routes that match, the most specific one wins (literal
// segments over parameters over catch-alls); a tie between routes leaves the
// call unlinked, as does a URL with a partly dynamic segment (`/u/${id}.json`).
// `match` is `exact` when every segment matched a literal, `catch-all` when a
// catch-all took the end, otherwise `parameter`. Routes of method ALL match
// any method; middleware mounts (USE) match none.
//
// Before matching, each call's URL is resolved in place: a call on a
// receiver (`api.get(…)`, `httpReceiver`) takes the client and base URL of
// the instance variable the receiver resolves to, in the file or through
// imports, and loses its request otherwise; `${NAME}` placeholders become the
// string constants they name (same file or imported); the base is joined to
// a relative URL; and a local origin (`http://localhost:3000`, `127.0.0.1`,
// `0.0.0.0`) is dropped, so the URL becomes a path. A URL that is a single
// unresolved variable is left null.

type RouteSegment = { kind: "literal"; value: string } | { kind: "param" } | { kind: "catch-all"; optional: boolean };
type RouteEntry = { id: string; method: string; segments: RouteSegment[] };

export const httpRequestsContributor: ISemanticContributor = {
  contribute(graph) {
    resolveRequestUrls(graph.nodes, graph.relationships);
    const routes: RouteEntry[] = [];
    for (const node of graph.nodes) {
      if (node.label !== "Route" || typeof node.properties.fullPath !== "string") continue;
      const method = String(node.properties.method).toUpperCase();
      if (method === "USE") continue;
      routes.push({ id: node.id, method, segments: routeSegments(node.properties.fullPath) });
    }
    if (routes.length === 0) return;

    const added: GraphRelationship[] = [];
    for (const call of graph.nodes) {
      const request = requestOf(call);
      if (!request) continue;
      let best: { route: RouteEntry; score: number; match: string } | null = null;
      let tied = false;
      for (const route of routes) {
        if (route.method !== request.method && route.method !== "ALL") continue;
        const matched = matchSegments(request.segments, route.segments);
        if (!matched) continue;
        if (!best || matched.score > best.score) {
          best = { route, ...matched };
          tied = false;
        } else if (matched.score === best.score) {
          tied = true;
        }
      }
      if (!best || tied) continue;
      added.push({
        from: call.id,
        to: best.route.id,
        type: "REQUESTS",
        properties: { method: request.method, url: request.url, match: best.match },
      });
    }
    for (const rel of added) graph.addRelationship(rel);
  },
};

function resolveRequestUrls(nodes: GraphNode[], relationships: GraphRelationship[]): void {
  const calls = nodes.filter((node) => node.label === "Call" && (node.properties.httpMethod !== undefined || node.properties.httpReceiver !== undefined));
  if (calls.length === 0) return;
  const index = createResolutionRelationshipIndex(relationships);
  const importNodesByFile = indexImportNodesByFile(nodes, index.fileByImportId);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fileByVariableId = new Map<string, string>();
  const variablesByFileAndName = new Map<string, Map<string, string[]>>();
  const addVariable = (fileId: string, name: string, id: string) => {
    const byName = variablesByFileAndName.get(fileId) ?? new Map<string, string[]>();
    byName.set(name, [...(byName.get(name) ?? []), id]);
    variablesByFileAndName.set(fileId, byName);
  };
  for (const rel of relationships) {
    const variable = rel.type === "DEFINES_VARIABLE" ? nodeById.get(rel.to) : undefined;
    if (variable?.label !== "Variable" || typeof variable.properties.name !== "string") continue;
    fileByVariableId.set(variable.id, rel.from);
    addVariable(rel.from, variable.properties.name, variable.id);
  }
  // `export default api` / `module.exports = api`.
  for (const [fileId, byName] of variablesByFileAndName) {
    const name = nodeById.get(fileId)?.properties.defaultExport;
    const ids = typeof name === "string" && !byName.has("default") ? byName.get(name) : undefined;
    if (ids) byName.set("default", ids);
  }
  const variableOf = (name: string, fileId: string) => {
    const id = resolveDeclaration(name, fileId, variablesByFileAndName, importNodesByFile, index.resolvedFileByImportId);
    return id ? nodeById.get(id) : undefined;
  };
  const substitute = (text: string, fileId: string) => text.replace(/\$\{([A-Za-z_$][\w$]*)\}/gu, (placeholder, name: string) => {
    const value = variableOf(name, fileId)?.properties.stringValue;
    return typeof value === "string" ? value : placeholder;
  });

  for (const call of calls) {
    const callerFunctionId = index.callerFunctionByCallId.get(call.id);
    const fileId = index.callerFileByModuleCallId.get(call.id) ?? (callerFunctionId ? index.fileByFunctionId.get(callerFunctionId) : undefined);
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
    const url = substitute(written, fileId);
    call.properties.httpUrl = /^\$\{[^}]*\}$/u.test(url) && base === null ? null : localPath(joinBaseUrl(base, url));
  }
}

function joinBaseUrl(base: string | null, url: string): string {
  if (base === null || /^[a-z][a-z\d+.-]*:\/\//iu.test(url)) return url;
  if (url === "") return base;
  return `${base.replace(/\/+$/u, "")}/${url.replace(/^\/+/u, "")}`;
}

function localPath(url: string): string {
  const match = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?=[/]|$)/iu.exec(url);
  return match ? url.slice(match[0].length) || "/" : url;
}

// The method and URL segments of an HTTP call: `null` for a dynamic segment.
function requestOf(call: GraphNode): { method: string; url: string; segments: Array<string | null> } | null {
  const { httpMethod, httpUrl } = call.properties;
  if (call.label !== "Call" || typeof httpMethod !== "string" || typeof httpUrl !== "string" || !httpUrl.startsWith("/")) return null;
  const segments: Array<string | null> = [];
  for (const segment of httpUrl.split("/").filter(Boolean)) {
    if (/^\$\{[^}]*\}$/u.test(segment)) segments.push(null);
    else if (segment.includes("${")) return null;
    else segments.push(decodeSegment(segment));
  }
  return { method: httpMethod, url: httpUrl, segments };
}

function routeSegments(fullPath: string): RouteSegment[] {
  return fullPath.split("/").filter(Boolean).map((segment): RouteSegment => {
    if (/^\[\[\.\.\..+\]\]$/u.test(segment)) return { kind: "catch-all", optional: true };
    if (/^\[\.\.\..+\]$/u.test(segment) || segment === "*" || /^:[^/]+[*+]$/u.test(segment) || segment === "(.*)") {
      return { kind: "catch-all", optional: segment.endsWith("*") && segment !== "*" };
    }
    if (/^(?::[^/]+|\[[^/]+\]|\{[^/]+\})$/u.test(segment)) return { kind: "param" };
    return { kind: "literal", value: decodeSegment(segment) };
  });
}

// Segment scores: 3 for a literal, 2 for a parameter, 1 for a catch-all.
function matchSegments(url: ReadonlyArray<string | null>, route: readonly RouteSegment[]): { score: number; match: string } | null {
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

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
