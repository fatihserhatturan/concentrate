import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { PythonParsePlugin } from "../../languages/python/parser.js";
import { walk } from "../../languages/tree-sitter-utils.js";
import { classifyFile } from "../../../core/scan/file-classification.js";
import { ENV_VALUE_FILES, readEnvFiles } from "../js-ts/env-files.js";
import type { PythonContext } from "./context.js";
import { argsOf, compact, createOwnerOf, lastSegment, stringConstants, stringOnly, stringValue, unwrap } from "./syntax.js";

// Python outbound HTTP, recorded on the Call node like the JS/TS, Go and Rust
// clients (`httpClient`, `httpMethod`, `httpUrl`) so the http-requests
// contributor links it to the Route it reaches (REQUESTS, with the
// `--api-origin` rules):
//   - requests: `requests.get(url)` (get, post, put, patch, delete, head,
//     options, `request("GET", url)`) and the same on a `requests.Session()`;
//   - httpx: `httpx.get(url)` and the methods of `httpx.Client(...)` /
//     `httpx.AsyncClient(...)` (also `with … as client`, `self.client`, an
//     annotated parameter), `client.request("GET", url)` and `stream`;
//   - aiohttp: the methods of an `aiohttp.ClientSession(...)`.
// Test files are skipped: their clients drive the app in process.
// The method is the function's name or the `request` argument. The URL is a
// string literal, a module or class constant, an f-string, `%` / `.format`
// template, `+` concatenation or `urljoin`; a client's `base_url` is put in
// front of a relative one. An `os.environ["X"]` / `os.getenv("X")` part is
// `${env:X}`, which the contributor below resolves from the nearest `.env*`
// file when that gives a URL or path; any other dynamic part becomes
// `${expression}` and matches a route parameter, or leaves the call unlinked
// when it starts the URL.

const METHODS = new Map([["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"], ["head", "HEAD"], ["options", "OPTIONS"]]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const CLIENT_FACTORIES = new Map<string, "requests" | "httpx" | "aiohttp">([
  ["requests.Session", "requests"], ["requests.session", "requests"], ["httpx.Client", "httpx"], ["httpx.AsyncClient", "httpx"], ["aiohttp.ClientSession", "aiohttp"],
]);
const CLIENT_TYPES = new Map<string, "requests" | "httpx" | "aiohttp">([
  ["requests.Session", "requests"], ["Session", "requests"], ["httpx.Client", "httpx"], ["httpx.AsyncClient", "httpx"], ["Client", "httpx"], ["AsyncClient", "httpx"], ["aiohttp.ClientSession", "aiohttp"], ["ClientSession", "aiohttp"],
]);

export const pythonHttpPlugin: PythonParsePlugin = ({ fileNodeId, relativePath, root, nodes, relationships, functions }) => {
  const source = root.text;
  if (!/\brequests\b|\bhttpx\b|\baiohttp\b/u.test(source)) return;
  // A test drives the app in process (a client of `app=app`, fixtures): not an outbound request.
  if (classifyFile(relativePath, false, true).isTest) return;
  const constants = stringConstants(root);
  const ownerOf = createOwnerOf(fileNodeId, functions);
  const functionById = new Map(functions.map((fn) => [fn.node.id, fn]));

  // `from requests import get` and friends.
  const bareFunctions = new Map<string, { library: "requests" | "httpx"; name: string }>();
  for (const match of source.matchAll(/^\s*from\s+(requests|httpx)\s+import\s+([^\n(]+)/gmu)) {
    for (const part of match[2]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/u)[0]!.trim();
      const alias = part.trim().split(/\s+as\s+/u)[1]?.trim() ?? name;
      if (METHODS.has(name) || name === "request") bareFunctions.set(alias, { library: match[1] as "requests" | "httpx", name });
    }
  }
  const bareClients = new Map<string, "requests" | "httpx" | "aiohttp">();
  for (const match of source.matchAll(/^\s*from\s+(requests|httpx|aiohttp)\s+import\s+([^\n(]+)/gmu)) {
    for (const part of match[2]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/u)[0]!.trim();
      const alias = part.trim().split(/\s+as\s+/u)[1]?.trim() ?? name;
      const known = CLIENT_FACTORIES.get(`${match[1]}.${name}`);
      if (known) bareClients.set(alias, known);
    }
  }
  const factoryOf = (callee: string): "requests" | "httpx" | "aiohttp" | undefined => CLIENT_FACTORIES.get(callee) ?? bareClients.get(callee);

  // Names bound to a client, with the `base_url` they were made with.
  const clients = new Map<string, { library: "requests" | "httpx" | "aiohttp"; base: SyntaxNode | null }>();
  const bind = (target: SyntaxNode | null | undefined, value: SyntaxNode | null | undefined) => {
    const call = unwrap(value);
    if (!target || call?.type !== "call") return;
    const library = factoryOf(compact(call.childForFieldName("function")?.text ?? ""));
    if (!library) return;
    const name = compact(target.text);
    // A client over the app itself (`app=`, an ASGI / WSGI transport) is a test client, not a request.
    const keywords = argsOf(call).keywords;
    if (keywords.has("app") || /\b(?:ASGITransport|WSGITransport)\b/u.test(keywords.get("transport")?.text ?? "")) return;
    if (/^[A-Za-z_][\w.]*$/u.test(name)) clients.set(name, { library, base: keywords.get("base_url") ?? keywords.get("base") ?? null });
  };
  walk(root, (node) => {
    if (node.type === "assignment") bind(node.childForFieldName("left"), node.childForFieldName("right"));
    else if (node.type === "as_pattern") {
      const target = node.namedChildren.find((child) => child.type === "as_pattern_target")?.namedChildren[0];
      bind(target, node.namedChildren[0]);
    }
  });
  for (const fn of functions) {
    for (const parameter of fn.syntax.childForFieldName("parameters")?.namedChildren ?? []) {
      const name = parameter.type === "typed_parameter" ? parameter.namedChildren.find((child) => child.type === "identifier")?.text : parameter.childForFieldName("name")?.text;
      const type = parameter.childForFieldName("type")?.text.replace(/^["']|["']$/gu, "").replace(/^Optional\[(.*)\]$/u, "$1");
      const library = type ? CLIENT_TYPES.get(compact(type)) : undefined;
      if (name && library && (/\.|^httpx|^requests|^aiohttp/u.test(type!) || new RegExp(`\\b(?:from\\s+(?:httpx|requests|aiohttp)\\s+import[^\\n]*\\b${type}\\b)`, "u").test(source))) clients.set(name, { library, base: null });
    }
  }
  // A class attribute assigned a client in `__init__`: `self.client = httpx.Client(...)`.
  const hasClients = clients.size > 0;

  const envName = (expression: SyntaxNode): string | null => {
    const inner = unwrap(expression);
    if (!inner) return null;
    if (inner.type === "subscript" && /^(?:os\.)?environ$/u.test(compact(inner.childForFieldName("value")?.text ?? ""))) return stringOnly(inner.childForFieldName("subscript") ?? undefined, constants);
    if (inner.type === "call") {
      const callee = compact(inner.childForFieldName("function")?.text ?? "");
      if (/^(?:os\.getenv|os\.environ\.get|getenv|env|config)$/u.test(callee) || /^env\.(?:str|url|get)$/u.test(callee)) return stringOnly(argsOf(inner).positional[0], constants);
    }
    return null;
  };
  const holder = (expression: SyntaxNode): string => {
    const env = envName(expression);
    if (env && /^\w+$/u.test(env)) return `\${env:${env}}`;
    const name = compact(expression.text).replace(/[{}/\s?#"']/gu, "_");
    return `\${${name.length > 40 ? name.slice(0, 40) : name}}`;
  };
  const urlText = (node: SyntaxNode | undefined | null, depth = 0): string | null => {
    const current = unwrap(node);
    if (!current || depth > 5) return null;
    // `urljoin(base, "/x")`.
    if (current.type === "call" && /(?:^|\.)urljoin$/u.test(compact(current.childForFieldName("function")?.text ?? ""))) {
      const [base, part] = argsOf(current).positional;
      const left = urlText(base, depth + 1) ?? (base ? holder(base) : "");
      const right = urlText(part, depth + 1) ?? (part ? holder(part) : "");
      return `${left.replace(/\/+$/u, "")}/${right.replace(/^\/+/u, "")}`;
    }
    const text = stringValue(current, constants, holder);
    if (text !== null) return text.replace(/%[sdr]/gu, "${_}");
    const env = envName(current);
    if (env && /^\w+$/u.test(env)) return `\${env:${env}}`;
    return null;
  };

  const callNodes = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.label === "Call" && node.id.startsWith(`${fileNodeId}:`)) callNodes.set(`${node.properties.line}:${node.properties.columnNumber}`, node);
  }

  for (const call of root.descendantsOfType("call")) {
    const callee = call.childForFieldName("function");
    if (!callee) continue;
    const text = compact(callee.text);
    const { positional, keywords } = argsOf(call);
    let library: "requests" | "httpx" | "aiohttp" | null = null;
    let method: string | null = null;
    let urlNode: SyntaxNode | undefined;
    let base: SyntaxNode | null = null;
    let position = call.startPosition;

    if (callee.type === "attribute") {
      const name = callee.childForFieldName("attribute")?.text ?? "";
      const object = compact(callee.childForFieldName("object")?.text ?? "");
      const isMethod = METHODS.has(name) || name === "request" || name === "stream";
      if (!isMethod) continue;
      if (object === "requests" || object === "httpx") {
        if (name === "stream" && object === "requests") continue;
        library = object;
      } else if (hasClients && clients.has(object)) {
        const client = clients.get(object)!;
        library = client.library;
        base = client.base;
      } else {
        continue;
      }
      position = (callee.childForFieldName("attribute") ?? call).startPosition;
      if (name === "request" || name === "stream") {
        const written = stringOnly(positional[0], constants)?.toUpperCase() ?? null;
        method = written && HTTP_METHODS.has(written) ? written : null;
        urlNode = positional[1] ?? keywords.get("url");
      } else {
        method = METHODS.get(name)!;
        urlNode = positional[0] ?? keywords.get("url");
      }
    } else if (callee.type === "identifier" && bareFunctions.has(text)) {
      const bare = bareFunctions.get(text)!;
      library = bare.library;
      urlNode = positional[0] ?? keywords.get("url");
      method = METHODS.get(bare.name) ?? null;
      if (bare.name === "request") {
        const written = stringOnly(positional[0], constants)?.toUpperCase() ?? null;
        method = written && HTTP_METHODS.has(written) ? written : null;
        urlNode = positional[1] ?? keywords.get("url");
      }
    } else {
      continue;
    }
    if (!library || !urlNode) continue;
    let url = urlText(urlNode);
    if (url === null) url = holder(urlNode);
    if (base && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) {
      const prefix = urlText(base) ?? holder(base);
      url = `${prefix.replace(/\/+$/u, "")}/${url.replace(/^\/+/u, "")}`;
    }
    url = withoutQuery(url);

    const line = position.row + 1;
    let node = callNodes.get(`${line}:${position.column}`);
    const fn = functionById.get(ownerOf(line));
    if (!node && fn) {
      const expression = text.length > 120 ? `${text.slice(0, 117)}...` : text;
      node = {
        id: `${fn.node.id}:call:${line}:${position.column}:${expression}`,
        label: "Call",
        properties: { name: expression, expression, callee: lastSegment(text), receiver: null, line, columnNumber: position.column },
      };
      nodes.push(node);
      callNodes.set(`${line}:${position.column}`, node);
      relationships.push({ from: fn.node.id, to: node.id, type: "CALLS", properties: {} });
    }
    if (!node) continue;
    node.properties.httpClient = library;
    node.properties.httpMethod = method;
    node.properties.httpUrl = url;
  }
};

// The URL without its query string or hash (outside placeholders).
function withoutQuery(url: string): string {
  let depth = 0;
  for (let index = 0; index < url.length; index++) {
    if (url.startsWith("${", index)) depth++;
    else if (url[index] === "}" && depth > 0) depth--;
    else if (depth === 0 && (url[index] === "?" || url[index] === "#")) return url.slice(0, index);
  }
  return url;
}

// Resolves the `${env:X}` parts of Python request URLs from the nearest
// `.env*` file (only a URL or path value). Runs before the http-requests
// contributor.
export async function addPythonHttpEnv(context: PythonContext, rootPath: string, files: readonly string[] | undefined): Promise<void> {
  const { graph } = context;
  const clients = new Set(["requests", "httpx", "aiohttp"]);
  const calls = graph.nodes.filter((node) => node.label === "Call" && typeof node.properties.httpClient === "string" && clients.has(node.properties.httpClient) && typeof node.properties.httpUrl === "string" && node.properties.httpUrl.includes("${env:"));
  if (calls.length === 0) return;
  const env = await readEnvFiles(rootPath, files as never);
  const envValue = (name: string, fileId: string): string | undefined => {
    let directory = path.posix.dirname(String(context.nodeById.get(fileId)?.properties.relativePath ?? "").replaceAll("\\", "/"));
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
  for (const call of calls) {
    const functionId = context.relationshipIndex.callerFunctionByCallId.get(call.id);
    const fileId = context.relationshipIndex.callerFileByModuleCallId.get(call.id) ?? (functionId ? context.relationshipIndex.fileByFunctionId.get(functionId) : undefined);
    if (!fileId) continue;
    call.properties.httpUrl = String(call.properties.httpUrl).replace(/\$\{env:(\w+)\}/gu, (written, name: string) => {
      const value = envValue(name, fileId);
      return value !== undefined && /^(?:https?:\/\/|\/)/u.test(value) ? value : written;
    });
  }
}
