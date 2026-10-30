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
//   (Nuxt's global) unless the file declares one.
// The method is the member name or the literal `method` option (GET when
// there is none); options that are not an object literal, or that spread
// another object, leave it null. The URL is a string or template literal as
// written, without its query string or hash; anything else (a variable, a
// call) leaves it null.

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function applyHttpClientSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): void {
  const imported = defaultAndNamedImports(parsed.nodes, parsed.relationships, fileNodeId);
  const declared = new Set(parsed.nodes.filter((node) => node.label === "Function" && node.properties.className == null).map((node) => String(node.properties.name)));
  const local = (name: string) => declared.has(name) || imported.has(name);
  const axios = new Set([...imported].filter(([, from]) => from === "axios:default").map(([name]) => name));
  const ky = new Set([...imported].filter(([, from]) => from === "ky:default").map(([name]) => name));
  const ofetch = new Set([...imported].filter(([, from]) => from === "ofetch:ofetch" || from === "ofetch:$fetch").map(([name]) => name));
  if (!local("$fetch")) ofetch.add("$fetch");

  const callsByPosition = new Map<string, GraphNode>();
  for (const node of parsed.nodes) {
    if (node.label === "Call" && !String(node.properties.expression).startsWith("new ")) {
      callsByPosition.set(`${node.properties.line}:${node.properties.columnNumber}`, node);
    }
  }

  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const request = httpRequest(node, { fetch: !local("fetch"), axios, ky, ofetch });
      const call = request ? callsByPosition.get(`${node.startPosition.row + 1}:${node.startPosition.column}`) : undefined;
      if (request && call) {
        call.properties.httpClient = request.client;
        call.properties.httpMethod = request.method;
        call.properties.httpUrl = request.url;
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(rootNode);
}

type Clients = { fetch: boolean; axios: Set<string>; ky: Set<string>; ofetch: Set<string> };
type Request = { client: string; method: string | null; url: string | null };

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

// A string or template literal as written, without query string or hash.
function urlOf(node: SyntaxNode | undefined): string | null {
  if (node?.type !== "string" && node?.type !== "template_string") return null;
  return node.text.slice(1, -1).replace(/[?#].*$/su, "");
}

// Local name → `source:imported` for default (`imported` = "default") and
// named imports of the file.
function defaultAndNamedImports(nodes: GraphNode[], relationships: JsTsParsedFile["parsed"]["relationships"], fileNodeId: string): Map<string, string> {
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
