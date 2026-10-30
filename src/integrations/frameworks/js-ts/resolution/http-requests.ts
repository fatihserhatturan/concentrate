import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../../core/contracts/semantic-contributor.js";
import { createVariableResolver } from "./variable-resolver.js";

// REQUESTS: an outbound HTTP call (`Call.httpMethod` / `httpUrl`, set by the
// http-clients and trpc parse plugins) to the Route it reaches, matched on the method
// and the route's full path. Only same-origin paths (`/api/users`) are
// matched. A `${…}` segment of a template URL matches a route parameter
// (`:id`, `[id]`, `{id}`); a literal segment matches the same literal or a
// parameter; a catch-all (`*`, `[...slug]`, `[[...slug]]`, `:path*`) takes
// the rest. Of the routes that match, the most specific one wins (literal
// segments over parameters over catch-alls); a tie between routes leaves the
// call unlinked, as does a URL with a partly dynamic segment (`/u/${id}.json`).
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
// of `envFiles`, or else from a literal fallback (`?? "http://localhost:4000"`).
// Only values that are URLs or paths are used, and a URL resolved through env
// is kept only when it ends up a path; otherwise it stays as written.

const envFiles = [".env.development.local", ".env.local", ".env.development", ".env", ".env.example", ".env.sample"];

type RouteSegment = { kind: "literal"; value: string } | { kind: "param" } | { kind: "catch-all"; optional: boolean };
type RouteEntry = { id: string; method: string; segments: RouteSegment[] };

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
      routes.push({ id: node.id, method, segments: routeSegments(node.properties.fullPath) });
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

// Directory (relative, "" for the root) → env file name → values.
type EnvFiles = Map<string, Map<string, Map<string, string>>>;

async function readEnvFiles(rootPath: string, files: readonly string[]): Promise<EnvFiles> {
  const result: EnvFiles = new Map();
  for (const file of files) {
    const name = path.basename(file);
    if (!envFiles.includes(name)) continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const directory = path.relative(rootPath, path.dirname(file)).split(path.sep).join("/");
    const byName = result.get(directory) ?? new Map<string, Map<string, string>>();
    byName.set(name, parseEnvFile(content));
    result.set(directory, byName);
  }
  return result;
}

// `KEY=value`, `export KEY="value"`; `#` comments.
function parseEnvFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const raw = match[2]!.trim();
    const quoted = /^(["'`])(.*)\1$/u.exec(raw);
    values.set(match[1]!, quoted ? quoted[2]! : raw.replace(/\s+#.*$/u, ""));
  }
  return values;
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
      for (const file of envFiles) {
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
    const url = substitute(written, fileId);
    const resolved = /^\$\{[^}]*\}$/u.test(url) && base === null ? null : localPath(joinBaseUrl(base, url), origins);
    call.properties.httpUrl = usedEnv && !resolved?.startsWith("/") ? written : resolved;
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
