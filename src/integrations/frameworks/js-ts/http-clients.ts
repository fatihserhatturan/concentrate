import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, ImportBinding } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";

// Outbound HTTP calls, recorded on their Call node as `httpClient`,
// `httpMethod` and `httpUrl` (the http-requests contributor links them to
// routes):
// - `fetch(url, init?)` (also `window.fetch` / `globalThis.fetch`) when the
//   file does not declare or import its own `fetch`;
// - axios: `axios(url | config)`, `axios.request(config)` and
//   `axios.get(url)` / `.post` / … on the default import of `axios`;
// - ky: `ky(url, options?)` and `ky.get(url)` / … on the default import of `ky`;
// - ofetch: `ofetch(url, options?)` imported from `ofetch`, and `$fetch`
//   (Nuxt's global) unless the file declares one;
// - data-fetching hooks whose key is the URL (GET): `useSWR(key, fetcher?)`
//   and `useSWRImmutable` (client `swr`), and TanStack Query's `useQuery`,
//   `useSuspenseQuery`, `useInfiniteQuery` and `queryOptions` without a
//   `queryFn` (the default query function fetches the key; client
//   `tanstack-query`), in object or v3 positional form. The URL is the key, or
//   the first element of an array key, when it is a string or template that
//   starts with `/` or `http`, or a template that starts with a substitution
//   (a ternary with one side null, too); a query
//   with its own `queryFn` is left to the calls inside it.
// The method is the member name or the literal `method` option (GET when
// there is none); options that are not an object literal, or that spread
// another object, leave it null. The URL is a string or template literal as
// written, without its query string or hash, or `${NAME}` for a variable the
// http-requests contributor may resolve to a string constant; anything else
// (a call, a member expression) leaves it null.
//
// Instances: `const api = axios.create({ baseURL })`, `ky.create` /
// `ky.extend({ prefixUrl })` and `ofetch.create({ baseURL })` (also as the
// default export) mark their Variable with `httpClient` and `httpBaseUrl`
// (as written; any other expression, a variable or `process.env.API_URL ?? …`,
// as `${expression}`).
// Calls on a receiver that may be one, `api.get(url)` / `api.request(…)` or
// `api(url | config)` on an imported or local binding, are recorded with
// `httpReceiver` and no `httpClient`; the contributor resolves the receiver
// through imports and drops the request when it is not an instance.

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function applyHttpClientSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): void {
  const imported = defaultAndNamedImports(parsed.nodes, parsed.relationships, fileNodeId);
  const declared = new Set(parsed.nodes.filter((node) => node.label === "Function" && node.properties.className == null).map((node) => String(node.properties.name)));
  const local = (name: string) => declared.has(name) || imported.has(name);
  const axios = new Set([...imported].filter(([, from]) => from === "axios:default").map(([name]) => name));
  const ky = new Set([...imported].filter(([, from]) => from === "ky:default").map(([name]) => name));
  const ofetch = new Set([...imported].filter(([, from]) => from === "ofetch:ofetch" || from === "ofetch:$fetch").map(([name]) => name));
  if (!local("$fetch")) ofetch.add("$fetch");
  const swr = new Set([...imported].filter(([, from]) => from === "swr:default" || from === "swr/immutable:default").map(([name]) => name));
  const query = new Set([...imported].filter(([, from]) => queryHook.test(from)).map(([name]) => name));

  const bindings = new Set([...imported.keys(), ...parsed.nodes.filter((node) => node.label === "Variable").map((node) => String(node.properties.name))]);
  markInstances(rootNode, parsed.nodes, { axios, ky, ofetch });

  const callsByPosition = new Map<string, GraphNode>();
  for (const node of parsed.nodes) {
    if (node.label === "Call" && !String(node.properties.expression).startsWith("new ")) {
      callsByPosition.set(`${node.properties.line}:${node.properties.columnNumber}`, node);
    }
  }

  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const request = httpRequest(node, { fetch: !local("fetch"), axios, ky, ofetch }) ?? keyRequest(node, swr, query) ?? instanceRequest(node, bindings);
      const call = request ? callsByPosition.get(`${node.startPosition.row + 1}:${node.startPosition.column}`) : undefined;
      if (request && call) {
        if (request.client) call.properties.httpClient = request.client;
        if (request.receiver) call.properties.httpReceiver = request.receiver;
        call.properties.httpMethod = request.method;
        call.properties.httpUrl = request.url;
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(rootNode);
}

const queryHook = /^(?:@tanstack\/(?:react|vue|solid|svelte|angular)-query(?:-experimental)?|react-query):(?:useQuery|useSuspenseQuery|useInfiniteQuery|useSuspenseInfiniteQuery|queryOptions)$/u;

// `useSWR('/api/user', fetcher)`, `useQuery({ queryKey: ['/api/todos'] })`.
function keyRequest(call: SyntaxNode, swr: ReadonlySet<string>, query: ReadonlySet<string>): Request | null {
  const callee = call.childForFieldName("function")?.text ?? "";
  const args = call.childForFieldName("arguments")?.namedChildren.filter((arg): arg is SyntaxNode => arg !== null) ?? [];
  let key: SyntaxNode | null | undefined;
  let client: string;
  if (swr.has(callee)) {
    client = "swr";
    key = args[0];
  } else if (query.has(callee)) {
    client = "tanstack-query";
    const options = args[0] ? entries(args[0]) : null;
    if (options) {
      if (options.has("queryFn")) return null;
      key = options.get("queryKey");
    } else {
      if (args[1]?.type === "arrow_function" || args[1]?.type === "function_expression" || args[1]?.type === "identifier") return null;
      key = args[0];
    }
  } else {
    return null;
  }
  const url = urlKey(key ?? undefined);
  return url ? { client, method: "GET", url } : null;
}

function urlKey(key: SyntaxNode | undefined): string | null {
  if (key?.type === "array") return urlKey(key.namedChildren[0] ?? undefined);
  if (key?.type === "ternary_expression") {
    const consequence = key.childForFieldName("consequence");
    const alternative = key.childForFieldName("alternative");
    if (alternative?.type === "null") return urlKey(consequence ?? undefined);
    if (consequence?.type === "null") return urlKey(alternative ?? undefined);
    return null;
  }
  if (key?.type !== "string" && key?.type !== "template_string") return null;
  const url = urlOf(key);
  return url !== null && /^(?:\/|https?:\/\/|\$\{)/u.test(url) && !(url.startsWith("${") && key.type === "string") ? url : null;
}

type Clients = { fetch: boolean; axios: Set<string>; ky: Set<string>; ofetch: Set<string> };
type Request = { client?: string; receiver?: string; method: string | null; url: string | null };

// `api.get(url)`, `api.request(config)` and `api(url | config)` on a binding
// that may hold an instance.
function instanceRequest(call: SyntaxNode, bindings: ReadonlySet<string>): Request | null {
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments")?.namedChildren.filter((arg): arg is SyntaxNode => arg !== null) ?? [];
  if (callee?.type === "identifier" && bindings.has(callee.text)) {
    if (args[0]?.type === "object") return { receiver: callee.text, ...configObject(args[0]) };
    if (args[0]?.type === "string" || args[0]?.type === "template_string") return { receiver: callee.text, ...urlAndOptions(args) };
    return null;
  }
  if (callee?.type !== "member_expression") return null;
  const receiver = callee.childForFieldName("object");
  const member = callee.childForFieldName("property")?.text ?? "";
  if (receiver?.type !== "identifier" || !bindings.has(receiver.text)) return null;
  if (member === "request" && args[0]?.type === "object") return { receiver: receiver.text, ...configObject(args[0]) };
  return methods.has(member) ? { receiver: receiver.text, method: member.toUpperCase(), url: urlOf(args[0]) } : null;
}

// `const api = axios.create({ baseURL })` and `export default axios.create(…)`.
function markInstances(root: SyntaxNode, nodes: GraphNode[], clients: Omit<Clients, "fetch">): void {
  const variables = new Map(nodes.filter((node) => node.label === "Variable").map((node) => [`${node.properties.line}:${node.properties.name}`, node]));
  for (const statement of root.namedChildren) {
    if (!statement) continue;
    const declaration = statement.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    const targets: Array<{ name: string; value: SyntaxNode | null; line: number }> = [];
    if (declaration?.type === "lexical_declaration" || declaration?.type === "variable_declaration") {
      for (const declarator of declaration.namedChildren) {
        const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
        if (name?.type === "identifier") targets.push({ name: name.text, value: declarator!.childForFieldName("value"), line: declarator!.startPosition.row + 1 });
      }
    } else if (statement.type === "export_statement" && statement.children.some((child) => child?.type === "default")) {
      targets.push({ name: "default", value: statement.childForFieldName("value"), line: statement.startPosition.row + 1 });
    }
    for (const { name, value, line } of targets) {
      const instance = value ? clientInstance(value, clients) : null;
      const variable = instance ? variables.get(`${line}:${name}`) : undefined;
      if (instance && variable) {
        variable.properties.httpClient = instance.client;
        variable.properties.httpBaseUrl = instance.baseUrl;
      }
    }
  }
}

function clientInstance(value: SyntaxNode, clients: Omit<Clients, "fetch">): { client: string; baseUrl: string | null } | null {
  if (value.type !== "call_expression") return null;
  const callee = value.childForFieldName("function");
  if (callee?.type !== "member_expression") return null;
  const receiver = callee.childForFieldName("object")?.text ?? "";
  const member = callee.childForFieldName("property")?.text ?? "";
  const client = clients.axios.has(receiver) && member === "create"
    ? "axios"
    : clients.ky.has(receiver) && (member === "create" || member === "extend")
      ? "ky"
      : clients.ofetch.has(receiver) && member === "create"
        ? "ofetch"
        : null;
  if (!client) return null;
  const options = value.childForFieldName("arguments")?.namedChildren[0];
  const option = options ? entries(options)?.get(client === "ky" ? "prefixUrl" : "baseURL") : undefined;
  if (option === undefined) return { client, baseUrl: options && !entries(options) ? options.text : null };
  return { client, baseUrl: option === null ? `\${${client === "ky" ? "prefixUrl" : "baseURL"}}` : urlOf(option) ?? `\${${option.text}}` };
}

function httpRequest(call: SyntaxNode, clients: Clients): Request | null {
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments")?.namedChildren.filter((arg): arg is SyntaxNode => arg !== null) ?? [];
  if (!callee) return null;

  if (callee.type === "identifier") {
    const name = callee.text;
    if (name === "fetch" && clients.fetch) return { client: "fetch", ...urlAndOptions(args) };
    if (clients.ky.has(name)) return { client: "ky", ...urlAndOptions(args) };
    if (clients.ofetch.has(name)) return { client: "ofetch", ...urlAndOptions(args) };
    if (clients.axios.has(name)) {
      return args[0]?.type === "object" ? { client: "axios", ...configObject(args[0]) } : { client: "axios", ...urlAndOptions(args) };
    }
    return null;
  }

  if (callee.type !== "member_expression") return null;
  const receiver = callee.childForFieldName("object")?.text ?? "";
  const member = callee.childForFieldName("property")?.text ?? "";
  if (member === "fetch" && (receiver === "window" || receiver === "globalThis") && clients.fetch) {
    return { client: "fetch", ...urlAndOptions(args) };
  }
  if (clients.axios.has(receiver)) {
    if (member === "request" && args[0]?.type === "object") return { client: "axios", ...configObject(args[0]) };
    if (methods.has(member)) return { client: "axios", method: member.toUpperCase(), url: urlOf(args[0]) };
  }
  if (clients.ky.has(receiver) && methods.has(member)) return { client: "ky", method: member.toUpperCase(), url: urlOf(args[0]) };
  return null;
}

// `client(url, { method })`.
function urlAndOptions(args: readonly SyntaxNode[]): { method: string | null; url: string | null } {
  return { url: urlOf(args[0]), method: args[1] === undefined ? "GET" : optionsMethod(args[1]) };
}

// axios `{ url, method }`.
function configObject(object: SyntaxNode): { method: string | null; url: string | null } {
  const url = entries(object)?.get("url");
  return { url: url ? urlOf(url) : null, method: optionsMethod(object) };
}

function optionsMethod(options: SyntaxNode): string | null {
  const values = entries(options);
  if (!values) return null;
  const method = values.get("method");
  if (method === undefined) return "GET";
  const literal = method?.type === "string" ? method.text.slice(1, -1).toLowerCase() : null;
  return literal && methods.has(literal) ? literal.toUpperCase() : null;
}

// The entries of an object literal; null when it is not one or spreads another.
function entries(node: SyntaxNode): Map<string, SyntaxNode | null> | null {
  if (node.type !== "object") return null;
  const values = new Map<string, SyntaxNode | null>();
  for (const entry of node.namedChildren) {
    if (entry?.type === "spread_element") return null;
    if (entry?.type === "pair") {
      const key = entry.childForFieldName("key");
      const name = key?.type === "string" ? key.text.slice(1, -1) : key?.text;
      if (name) values.set(name, entry.childForFieldName("value"));
    } else if (entry?.type === "shorthand_property_identifier") {
      values.set(entry.text, null);
    }
  }
  return values;
}

// A string or template literal as written, without query string or hash;
// `${NAME}` for a variable.
function urlOf(node: SyntaxNode | undefined): string | null {
  if (node?.type === "identifier") return `\${${node.text}}`;
  if (node?.type !== "string" && node?.type !== "template_string") return null;
  return node.text.slice(1, -1).replace(/[?#].*$/su, "");
}

// Local name → `source:imported` for default (`imported` = "default") and
// named imports of the file.
export function defaultAndNamedImports(nodes: GraphNode[], relationships: JsTsParsedFile["parsed"]["relationships"], fileNodeId: string): Map<string, string> {
  const importIds = new Set(relationships.filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS").map((rel) => rel.to));
  const imported = new Map<string, string>();
  for (const node of nodes) {
    if (node.label !== "Import" || !importIds.has(node.id) || typeof node.properties.bindings !== "string") continue;
    for (const binding of JSON.parse(node.properties.bindings) as ImportBinding[]) {
      imported.set(binding.local, `${node.properties.source}:${binding.kind === "default" ? "default" : binding.imported}`);
    }
  }
  return imported;
}
