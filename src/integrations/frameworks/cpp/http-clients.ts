import type { GraphNode } from "../../../core/graph/model.js";
import type { CppParsePlugin } from "../../languages/cpp/parser.js";
import { findInvocations, ownerOf, readCppSource, resolveString, stringConstants, stringValue, type CppSource, type Invocation } from "./scan.js";

// C and C++ outbound HTTP, recorded on the Call node like the JS/TS, Go and
// Rust clients (`httpClient`, `httpMethod`, `httpUrl`) so the http-requests
// contributor links it to the Route it reaches (REQUESTS):
//   - libcurl: the request is the `curl_easy_perform(handle)` (or `curl_multi_add_handle(multi, handle)`) call, with the
//     `CURLOPT_URL` of the handle (a literal, a constant, a local string, `+`
//     concatenation, `x.c_str()`; other parts are `${expression}`) and the
//     method of `CURLOPT_CUSTOMREQUEST` / `CURLOPT_POST` / `CURLOPT_POSTFIELDS`
//     / `CURLOPT_UPLOAD` / `CURLOPT_NOBODY` (GET otherwise);
//   - cpr: `cpr::Get(cpr::Url{…}, …)`, `Post`, `Put`, `Patch`, `Delete`,
//     `Head`, `Options` (and the `Async` / `Callback` forms), and a
//     `cpr::Session` with `SetUrl(…)` then `Get()`, `Post()` …;
//   - cpp-httplib: `cli.Get("/path")` of an `httplib::Client cli("http://host:port")`,
//     the base and path joined.

const CPR_METHODS = "Get|Post|Put|Patch|Delete|Head|Options";
const HTTP_METHOD = /^(?:Get|Post|Put|Patch|Delete|Head|Options)/u;

export const cppHttpClientsPlugin: CppParsePlugin = ({ fileNodeId, source: written, nodes, relationships }) => {
  const hasCurl = /\bcurl_easy_perform\b|\bcurl_multi_add_handle\b/u.test(written);
  const hasCpr = /\bcpr\b/u.test(written);
  const hasHttplib = /\bhttplib\b/u.test(written);
  if (!hasCurl && !hasCpr && !hasHttplib) return;
  const source = readCppSource(written);
  const constants = stringConstants(source);
  const owner = ownerOf(nodes, fileNodeId);
  const functions = nodes
    .filter((node) => node.label === "Function" && node.properties.isDeclaration !== true && typeof node.properties.line === "number" && typeof node.properties.endLine === "number")
    .map((node) => ({ id: node.id, start: source.offsetOfLine(Number(node.properties.line)), end: source.offsetOfLine(Number(node.properties.endLine) + 1) }));
  const functionStart = (offset: number) => functions.filter((fn) => fn.start <= offset && offset < fn.end).sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]?.start ?? 0;
  const calls = nodes.filter((node) => node.label === "Call");
  const callAt = (call: Invocation): GraphNode | undefined => {
    const candidates = calls.filter((node) => node.properties.line === call.line && node.properties.callee === call.name && Number(node.properties.columnNumber) <= call.column);
    let best = candidates.sort((left, right) => Number(right.properties.columnNumber) - Number(left.properties.columnNumber))[0];
    if (!best) {
      const fn = owner(call.line);
      if (fn === fileNodeId) return undefined;
      const expression = `${call.prefix}${call.name}`;
      best = {
        id: `${fn}:call:${call.line}:${call.column}:${expression}`,
        label: "Call",
        properties: { name: expression, expression, callee: call.name, receiver: call.receiver, line: call.line, columnNumber: call.column },
      };
      nodes.push(best);
      relationships.push({ from: fn, to: best.id, type: "CALLS", properties: {} });
    }
    return best;
  };
  const record = (call: Invocation, method: string, url: string, client: string) => {
    // libcurl speaks FTP, files and more: only HTTP(S) or a scheme-less URL is a request to a route.
    if (/^(?!https?:)[A-Za-z][A-Za-z0-9+.-]*:\/\//iu.test(url)) return;
    const node = callAt(call);
    if (!node) return;
    node.properties.httpClient = client;
    node.properties.httpMethod = method;
    node.properties.httpUrl = url;
  };

  // ---- libcurl ----
  if (hasCurl) {
    const options = findInvocations(source, "curl_easy_setopt").filter((call) => call.args.length >= 3);
    // The request is made where the handle is performed, or added to a multi handle.
    for (const perform of findInvocations(source, "curl_easy_perform|curl_multi_add_handle")) {
      const handle = perform.args[perform.name === "curl_easy_perform" ? 0 : 1]?.trim();
      if (!handle) continue;
      const from = functionStart(perform.start);
      const own = options.filter((option) => option.args[0]!.trim() === handle && option.start >= from && option.start < perform.start);
      let url: string | null = null;
      let method: string | null = null;
      let post = false;
      for (const option of own) {
        const name = option.args[1]!.trim();
        const value = option.args[2]!;
        if (name === "CURLOPT_URL") url = resolveString(source, value, option.start, from, constants);
        else if (name === "CURLOPT_CUSTOMREQUEST") method = (stringValue(value, constants) ?? "").toUpperCase() || null;
        else if (name === "CURLOPT_POST" || name === "CURLOPT_POSTFIELDS" || name === "CURLOPT_COPYPOSTFIELDS" || name === "CURLOPT_MIMEPOST" || name === "CURLOPT_HTTPPOST") post = !/^(?:0L?|false)$/u.test(value.trim());
        else if (name === "CURLOPT_UPLOAD") method ??= /^(?:0L?|false)$/u.test(value.trim()) ? null : "PUT";
        else if (name === "CURLOPT_NOBODY") method ??= /^(?:0L?|false)$/u.test(value.trim()) ? null : "HEAD";
        else if (name === "CURLOPT_HTTPGET") post = false;
      }
      if (url !== null) record(perform, method ?? (post ? "POST" : "GET"), url, "libcurl");
    }
  }

  // ---- cpr ----
  if (hasCpr) {
    for (const call of findInvocations(source, `(?:${CPR_METHODS})(?:Async|Callback)?`)) {
      const method = HTTP_METHOD.exec(call.name)?.[0]?.toUpperCase();
      if (!method) continue;
      if (call.qualifier !== null && /(?:^|::)cpr$/u.test(call.qualifier)) {
        const from = functionStart(call.start);
        const written = call.args.find((argument) => /^(?:cpr::)?Url\s*[({]/u.test(argument)) ?? call.args.find((argument) => stringValue(argument, constants) !== null);
        const url = written === undefined ? null : resolveString(source, written.replace(/^(?:cpr::)?Url\s*[({]([\s\S]*)[)}]$/u, "$1"), call.start, from, constants);
        if (url !== null) record(call, method, url, "cpr");
      } else if (call.receiver !== null && call.args.length === 0) {
        // `session.SetUrl(cpr::Url{…}); session.Get();`
        const from = functionStart(call.start);
        const setter = findInvocations(source, "SetUrl", from, call.start).filter((candidate) => candidate.receiver === call.receiver).at(-1);
        if (!setter?.args[0]) continue;
        const url = resolveString(source, setter.args[0].replace(/^(?:cpr::)?Url\s*[({]([\s\S]*)[)}]$/u, "$1"), setter.start, from, constants);
        if (url !== null) record(call, method, url, "cpr");
      }
    }
  }

  // ---- cpp-httplib client ----
  if (hasHttplib) {
    const bases = new Map<string, string>();
    for (const match of source.code.matchAll(/\b(?:httplib::)?(?:SSL)?Client\b[\s>*&]*(\w+)\s*[({]/gu)) {
      const open = match.index + match[0].length - 1;
      const close = findClose(source, open);
      if (close === -1) continue;
      const args = source.text.slice(open + 1, close).split(",");
      const host = stringValue(args[0] ?? "", constants);
      if (host === null) continue;
      const port = args[1] ? /^\s*(\d+)\s*$/u.exec(args[1])?.[1] : undefined;
      const origin = /^https?:\/\//u.test(host) ? host : `http://${host}${port ? `:${port}` : ""}`;
      bases.set(match[1]!, origin.replace(/\/$/u, ""));
    }
    if (bases.size > 0) {
      for (const call of findInvocations(source, "Get|Post|Put|Patch|Delete|Head|Options")) {
        if (call.receiver === null || call.args.length === 0) continue;
        const base = bases.get(call.receiver.split(/(?:\.|->)/u).at(-1)!);
        const path = base === undefined ? null : stringValue(call.args[0]!, constants);
        if (base !== undefined && path !== null) record(call, call.name.toUpperCase(), `${base}${path}`, "httplib");
      }
    }
  }
};

function findClose(source: CppSource, open: number): number {
  let depth = 0;
  for (let position = open; position < source.code.length; position += 1) {
    const char = source.code[position]!;
    if (char === "(" || char === "{") depth += 1;
    else if (char === ")" || char === "}") {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  return -1;
}

