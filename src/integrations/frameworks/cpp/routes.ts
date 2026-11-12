import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { CppParsePlugin } from "../../languages/cpp/parser.js";
import { findInvocations, matching, ownerOf, readCppSource, scopeAt, scopesOf, stringConstants, stringValue, type CppSource } from "./scan.js";

// C++ HTTP routes. The macros and calls of the web frameworks are read from
// the written source (the grammar drops a macro at class scope):
//   - Crow: `CROW_ROUTE(app, "/x")` (`.methods(…)`, `crow::HTTPMethod::Post`,
//     `"POST"_method`) and `CROW_BP_ROUTE(bp, "/x")`; a `crow::Blueprint bp("api")`
//     prefixes its routes, a blueprint registered on another one nests.
//   - Drogon: `METHOD_ADD(Ctrl::fn, "/{1}/info", Get)` (the path follows the
//     controller's namespace and name, `/api/v1/User/{1}/info`),
//     `ADD_METHOD_TO` / `ADD_METHOD_VIA_REGEX` (the path as written),
//     `PATH_ADD("/x", Get)` of an `HttpSimpleController` (handled by its
//     `asyncHandleHttpRequest`), and `app().registerHandler("/x", handler, {Get})`.
//   - Pistache: `Routes::Get(router, "/x", Routes::bind(&Ctrl::fn, this))`.
//   - cpp-httplib: `svr.Get("/x", handler)` on an `httplib::Server`.
// A named handler (`&Ctrl::fn`, `fn`, `std::bind(&Ctrl::fn, this, …)`) is
// found once every file is parsed (ROUTE_HANDLED_BY); a lambda handler is
// the route itself (its lines are kept so data access inside it is the
// route's).

export type CppHandlerRef = { className: string | null; name: string };
export type CppPendingRoute = {
  handler: CppHandlerRef | null;
  blueprint: string | null;
  // The lines of an inline lambda handler.
  lambda: [number, number] | null;
  prefix: string;
};
type Blueprint = { name: string; prefix: string | null; parents: string[]; file?: string };

const METHOD_NAMES = new Map([["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"], ["head", "HEAD"], ["options", "OPTIONS"], ["trace", "TRACE"], ["connect", "CONNECT"]]);
const DROGON_METHODS = /^(?:drogon::)?(Get|Post|Put|Delete|Patch|Head|Options)$/u;

export const cppRoutesPlugin: CppParsePlugin = ({ fileNodeId, relativePath, source: written, nodes, relationships }) => {
  if (/(^|[\\/])(?:tests?|unittests?)[\\/]/u.test(relativePath)) return;
  const frameworks = {
    crow: /\bCROW_(?:BP_)?ROUTE\b|\bcrow::/u.test(written),
    drogon: /\b(?:METHOD_ADD|ADD_METHOD_TO|ADD_METHOD_VIA_REGEX|PATH_ADD|WS_PATH_ADD|WS_ADD_PATH_VIA_REGEX|registerHandler(?:ViaRegex)?)\b/u.test(written),
    pistache: /\bRoutes::(?:Get|Post|Put|Delete|Patch|Head|Options)\b/u.test(written),
    httplib: /\bhttplib\b/u.test(written),
  };
  if (!Object.values(frameworks).some(Boolean)) return;
  const source = readCppSource(written);
  const constants = stringConstants(source);
  const scopes = scopesOf(source);
  const owner = ownerOf(nodes, fileNodeId);
  const usedIds = new Set<string>();
  const blueprints: Blueprint[] = [];

  const addRoute = (draft: { method: string; path: string | null; expression: string | null; framework: string; line: number; column: number; handlerName: string | null; pending: CppPendingRoute; scopeFunctionId: string }) => {
    let id = `${fileNodeId}:route:${draft.line}:${draft.column}:${draft.method}:${draft.path ?? draft.expression}`;
    for (let n = 1; usedIds.has(id); n += 1) id = `${id.replace(/#\d+$/u, "")}#${n}`;
    usedIds.add(id);
    const node: GraphNode = {
      id,
      label: "Route",
      properties: {
        method: draft.method,
        path: draft.path,
        fullPath: null,
        pathExpression: draft.path === null ? draft.expression : null,
        receiverName: null,
        line: draft.line,
        framework: draft.framework,
        handlerName: draft.handlerName,
        pendingHandlerRefs: null,
        scopeFunctionId: draft.scopeFunctionId,
        layers: null,
        cppPending: JSON.stringify(draft.pending),
      },
    };
    nodes.push(node);
    relationships.push({ from: fileNodeId, to: node.id, type: "DECLARES_ROUTE", properties: {} });
  };

  // What follows a route's registration call: a lambda body or a function
  // reference (`&Ctrl::fn`, `std::bind(&Ctrl::fn, this, _1)`, `fn`).
  const handlerAt = (argument: string | undefined, argumentStart: number | undefined): { ref: CppHandlerRef | null; lambda: [number, number] | null; name: string | null } => {
    if (!argument) return { ref: null, lambda: null, name: null };
    const trimmed = argument.trim();
    if (trimmed.startsWith("[")) {
      const body = source.code.indexOf("{", argumentStart ?? 0);
      const close = body === -1 ? -1 : matching(source.code, body);
      return { ref: null, lambda: close === -1 ? null : [source.lineAt(argumentStart ?? 0), source.lineAt(close)], name: "<lambda>" };
    }
    return { ...refOf(trimmed), lambda: null };
  };
  const refOf = (expression: string): { ref: CppHandlerRef | null; name: string | null } => {
    const bind = /^(?:Routes::|Rest::Routes::|Pistache::Rest::Routes::)?bind\s*\(\s*&?\s*([\w:]+)|^std::bind\s*\(\s*&?\s*([\w:]+)/u.exec(expression);
    const target = (bind ? bind[1] ?? bind[2] : /^&?\s*([\w:]+)$/u.exec(expression)?.[1]) ?? null;
    if (!target) return { ref: null, name: null };
    const parts = target.split("::").filter(Boolean);
    const name = parts.at(-1)!;
    return { ref: { className: parts.length > 1 ? parts.at(-2)! : null, name }, name: parts.length > 1 ? `${parts.at(-2)}::${name}` : name };
  };

  // ---- Crow ----
  if (frameworks.crow) {
    for (const match of source.code.matchAll(/\b(?:crow::)?Blueprint\s+(\w+)\s*\(/gu)) {
      const open = match.index + match[0].length - 1;
      const close = matching(source.code, open);
      const first = close === -1 ? null : findFirstArgument(source, open, close);
      const prefix = first === null ? null : stringValue(first, constants);
      blueprints.push({ name: match[1]!, prefix, parents: [] });
    }
    for (const call of findInvocations(source, "register_blueprint")) {
      const child = call.args[0]?.replace(/^&/u, "").trim();
      const parent = call.receiver?.split(/[.>-]+/u).at(-1);
      if (child && parent && /^\w+$/u.test(child)) {
        const entry = blueprints.find((blueprint) => blueprint.name === child);
        if (entry) entry.parents.push(parent);
      }
    }
    for (const call of findInvocations(source, "CROW_ROUTE|CROW_BP_ROUTE|CROW_WEBSOCKET_ROUTE")) {
      const isBlueprint = call.name === "CROW_BP_ROUTE";
      const websocketMacro = call.name === "CROW_WEBSOCKET_ROUTE";
      const pathText = call.args[1];
      const path = pathText === undefined ? null : stringValue(pathText, constants);
      // `CROW_ROUTE(app, "/x").methods("GET"_method, "POST"_method)(handler)`.
      let cursor = call.end;
      let methods: string[] = [];
      let websocket = false;
      for (;;) {
        const chain = /^\s*\.\s*(\w+)\s*(?:<[^()]*>\s*)?\(/u.exec(source.code.slice(cursor, cursor + 200));
        if (!chain) break;
        const open = cursor + chain[0].length - 1;
        const close = matching(source.code, open);
        if (close === -1) break;
        if (chain[1] === "methods") methods = [...methods, ...crowMethods(source.text.slice(open + 1, close))];
        else if (chain[1] === "websocket") websocket = true;
        cursor = close + 1;
      }
      const handlerOpen = /^\s*\(/u.exec(source.code.slice(cursor, cursor + 50));
      let handler: ReturnType<typeof handlerAt> = { ref: null, lambda: null, name: null };
      if (handlerOpen) {
        const open = cursor + handlerOpen[0].length - 1;
        const close = matching(source.code, open);
        if (close !== -1) handler = handlerAt(source.text.slice(open + 1, close), open + 1);
      }
      const blueprint = isBlueprint ? call.args[0]?.replace(/^&/u, "").trim() ?? null : null;
      for (const method of methods.length > 0 ? methods : ["GET"]) {
        addRoute({
          method, path, expression: path === null ? pathText ?? null : null, framework: "crow", line: call.line, column: call.column,
          handlerName: websocketMacro || websocket ? "<websocket>" : handler.name, pending: { handler: handler.ref, blueprint, lambda: handler.lambda, prefix: "" }, scopeFunctionId: owner(call.line),
        });
      }
    }
  }

  // ---- Drogon ----
  if (frameworks.drogon) {
    for (const call of findInvocations(source, "METHOD_ADD|ADD_METHOD_TO|ADD_METHOD_VIA_REGEX|ADD_METHOD_VIA_REGEX_TO")) {
      const target = refOf(call.args[0] ?? "").ref;
      const pathText = call.args[1];
      const pattern = pathText === undefined ? null : stringValue(pathText, constants);
      const methods = call.args.slice(2).flatMap((argument) => {
        const named = DROGON_METHODS.exec(argument.trim())?.[1];
        return named ? [named.toUpperCase()] : [];
      });
      const scope = scopeAt(scopes, call.start);
      const className = scope.className ?? target?.className ?? null;
      // METHOD_ADD paths follow the controller; ADD_METHOD_TO's are absolute.
      const prefixed = call.name === "METHOD_ADD";
      // A regular expression is registered as written.
      const regex = call.name.includes("VIA_REGEX");
      let path = pattern;
      if (path !== null && prefixed && className) {
        const controller = `/${[...scope.namespace.split("::").filter(Boolean), className].join("/")}`;
        path = pattern === "" ? controller : `${controller}${pattern!.startsWith("/") ? "" : "/"}${pattern}`;
      } else if (path !== null && path !== "" && !path.startsWith("/") && !regex) {
        path = `/${path}`;
      }
      for (const method of methods.length > 0 ? methods : ["ALL"]) {
        addRoute({
          method, path, expression: path === null ? pathText ?? null : null, framework: "drogon", line: call.line, column: call.column,
          handlerName: target ? `${target.className ?? className}::${target.name}`.replace(/^null::/u, "") : null,
          pending: { handler: target && !target.className && className ? { className, name: target.name } : target, blueprint: null, lambda: null, prefix: "" },
          scopeFunctionId: owner(call.line),
        });
      }
    }
    // `PATH_ADD("/x", Get)` of an HttpSimpleController, `WS_PATH_ADD("/x")` of a
    // WebSocketController (a GET handshake handled by `handleNewMessage`).
    for (const call of findInvocations(source, "PATH_ADD|WS_PATH_ADD|WS_ADD_PATH_VIA_REGEX|WS_CORO_PATH_ADD|WS_CORO_ADD_PATH_VIA_REGEX")) {
      const websocket = call.name.startsWith("WS_");
      const pathText = call.args[0];
      const path = pathText === undefined ? null : stringValue(pathText, constants);
      const className = scopeAt(scopes, call.start).className;
      const methods = call.args.slice(1).flatMap((argument) => {
        const named = DROGON_METHODS.exec(argument.trim())?.[1];
        return named ? [named.toUpperCase()] : [];
      });
      const handlerName = websocket ? "handleNewMessage" : "asyncHandleHttpRequest";
      for (const method of websocket ? ["GET"] : methods.length > 0 ? methods : ["ALL"]) {
        addRoute({
          method, path, expression: path === null ? pathText ?? null : null, framework: "drogon", line: call.line, column: call.column,
          handlerName: className ? `${className}::${handlerName}` : null,
          pending: { handler: className ? { className, name: handlerName } : null, blueprint: null, lambda: null, prefix: "" },
          scopeFunctionId: owner(call.line),
        });
      }
    }
    // `app().registerHandler("/x", handler, {Get, Post})`.
    for (const call of findInvocations(source, "registerHandler|registerHandlerViaRegex")) {
      if (call.receiver === null) continue;
      const pathText = call.args[0];
      const path = pathText === undefined ? null : stringValue(pathText, constants);
      const handler = handlerAt(call.args[1], call.argStarts[1]);
      const list = call.args.slice(2).join(",");
      const methods = [...list.matchAll(/(?:drogon::)?\b(Get|Post|Put|Delete|Patch|Head|Options)\b/gu)].map((match) => match[1]!.toUpperCase());
      for (const method of methods.length > 0 ? [...new Set(methods)] : ["ALL"]) {
        addRoute({
          method, path: path !== null && path !== "" && !path.startsWith("/") ? `/${path}` : path, expression: path === null ? pathText ?? null : null, framework: "drogon",
          line: call.line, column: call.column, handlerName: handler.name,
          pending: { handler: handler.ref, blueprint: null, lambda: handler.lambda, prefix: "" }, scopeFunctionId: owner(call.line),
        });
      }
    }
  }

  // ---- Pistache ----
  if (frameworks.pistache) {
    for (const call of findInvocations(source, "Get|Post|Put|Delete|Patch|Head|Options")) {
      if (!call.qualifier || !/(?:^|::)Routes$/u.test(call.qualifier)) continue;
      const pathText = call.args[1];
      const path = pathText === undefined ? null : stringValue(pathText, constants);
      const handler = handlerAt(call.args[2], call.argStarts[2]);
      addRoute({
        method: call.name.toUpperCase(), path, expression: path === null ? pathText ?? null : null, framework: "pistache", line: call.line, column: call.column,
        handlerName: handler.name, pending: { handler: handler.ref, blueprint: null, lambda: handler.lambda, prefix: "" }, scopeFunctionId: owner(call.line),
      });
    }
  }

  // ---- cpp-httplib ----
  if (frameworks.httplib) {
    const kinds = new Map<string, "server" | "client">();
    for (const match of source.code.matchAll(/\b(?:httplib::)?(Server|SSLServer|Client|SSLClient)\b[\s>*&]*(\w+)\s*(?:[({;=,)]|$)/gmu)) {
      kinds.set(match[2]!, match[1]!.endsWith("Server") ? "server" : "client");
    }
    for (const match of source.code.matchAll(/\b(\w+)\s*=\s*(?:std::)?make_(?:unique|shared)\s*<\s*(?:httplib::)?(Server|SSLServer|Client|SSLClient)\b/gu)) {
      kinds.set(match[1]!, match[2]!.endsWith("Server") ? "server" : "client");
    }
    for (const call of findInvocations(source, "Get|Post|Put|Delete|Patch|Options|Head")) {
      if (call.receiver === null) continue;
      const variable = call.receiver.split(/(?:\.|->)/u).at(-1)!.replace(/\(\)$/u, "");
      const kind = kinds.get(variable);
      const second = call.args[1];
      const lambdaLike = second !== undefined && (second.startsWith("[") || /^(?:std::bind|&|\w+$)/u.test(second));
      if (kind === "client" || (kind === undefined && !lambdaLike) || call.args.length < 2) continue;
      const pathText = call.args[0];
      if (!pathText) continue;
      const path = stringValue(pathText, constants);
      const handler = handlerAt(second, call.argStarts[1]);
      addRoute({
        method: call.name.toUpperCase(), path, expression: path === null ? pathText : null, framework: "httplib", line: call.line, column: call.column,
        handlerName: handler.name, pending: { handler: handler.ref, blueprint: null, lambda: handler.lambda, prefix: "" }, scopeFunctionId: owner(call.line),
      });
    }
  }

  const file = nodes.find((node) => node.id === fileNodeId);
  if (file && blueprints.length > 0) file.properties.cppBlueprints = JSON.stringify(blueprints.map((blueprint) => ({ ...blueprint, file: fileNodeId })));
};

function findFirstArgument(source: CppSource, open: number, close: number): string | null {
  let depth = 0;
  for (let position = open + 1; position < close; position += 1) {
    const char = source.code[position]!;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) return source.text.slice(open + 1, position).trim();
  }
  return source.text.slice(open + 1, close).trim() || null;
}

// `"GET"_method, crow::HTTPMethod::Post, HTTPMethod::GET`.
function crowMethods(list: string): string[] {
  const methods: string[] = [];
  for (const match of list.matchAll(/"(\w+)"\s*_method|(?:HTTPMethod::)(\w+)|"(\w+)"/gu)) {
    const name = (match[1] ?? match[2] ?? match[3])!.toLowerCase();
    const method = METHOD_NAMES.get(name);
    if (method) methods.push(method);
  }
  return [...new Set(methods)];
}

// ---- finishing, once every file is parsed ----

export const cppRoutesContributor: ISemanticContributor = {
  contribute(graph) {
    const routes = graph.nodes.filter((node) => node.label === "Route" && typeof node.properties.cppPending === "string");
    const files = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.cppBlueprints === "string");
    if (routes.length === 0 && files.length === 0) return;

    // Blueprints by name; a name declared in several files is read in the
    // file of the route (or of the blueprint that registers it).
    const blueprints = new Map<string, Blueprint[]>();
    for (const file of files) {
      for (const blueprint of JSON.parse(String(file.properties.cppBlueprints)) as Blueprint[]) blueprints.set(blueprint.name, [...blueprints.get(blueprint.name) ?? [], blueprint]);
      delete file.properties.cppBlueprints;
    }
    const lookup = (name: string, fileId: string): Blueprint | null => {
      const candidates = blueprints.get(name) ?? [];
      return candidates.find((candidate) => candidate.file === fileId) ?? (candidates.length === 1 ? candidates[0]! : null);
    };
    const prefixOf = (name: string, fileId: string, seen = new Set<string>()): string | null => {
      const blueprint = lookup(name, fileId);
      if (!blueprint || seen.has(name)) return null;
      const own = blueprint.prefix === null ? "" : blueprint.prefix.replace(/^\/+|\/+$/gu, "");
      const parents = blueprint.parents.filter((parent) => lookup(parent, fileId));
      const parent = parents.length === 1 ? prefixOf(parents[0]!, fileId, new Set([...seen, name])) ?? "" : "";
      return [parent, own].filter((part) => part !== "").join("/");
    };

    const functions = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) {
      if (node.label !== "Function" || node.properties.kind === "macro") continue;
      const key = String(node.properties.name);
      functions.set(key, [...functions.get(key) ?? [], node]);
    }
    const fileByRoute = new Map<string, string>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "DECLARES_ROUTE") fileByRoute.set(relationship.to, relationship.from);
    }
    // Function ids start with their file's id.
    const fileOfFunction = (node: GraphNode) => node.id.split(":function:")[0]!;
    const stem = (fileId: string) => fileId.replace(/^file:/u, "").replace(/\.[^./]+$/u, "");

    const resolve = (ref: CppHandlerRef, fileId: string): string | null => {
      let candidates = (functions.get(ref.name) ?? []).filter((node) => node.properties.kind !== "test");
      if (ref.className) candidates = candidates.filter((node) => node.properties.className === ref.className);
      if (candidates.length === 0) return null;
      // Definitions over declarations; the route's file, then its header or source twin.
      const rank = (node: GraphNode) => (node.properties.isDeclaration === true ? 4 : 0) + (fileOfFunction(node) === fileId ? 0 : stem(fileOfFunction(node)) === stem(fileId) ? 1 : 2);
      const sorted = [...candidates].sort((left, right) => rank(left) - rank(right));
      const best = sorted[0]!;
      // A bare name found in several unrelated places is not a handler we can name.
      if (!ref.className && sorted.filter((node) => rank(node) === rank(best)).length > 1) return null;
      return best.id;
    };

    const newRelationships: GraphRelationship[] = [];
    for (const route of routes) {
      const pending = JSON.parse(String(route.properties.cppPending)) as CppPendingRoute;
      delete route.properties.cppPending;
      const fileId = fileByRoute.get(route.id);
      if (!fileId) continue;
      const path = typeof route.properties.path === "string" ? route.properties.path : null;
      let fullPath = path;
      if (pending.blueprint && path !== null) {
        const prefix = prefixOf(pending.blueprint, fileId);
        if (prefix === null) route.properties.pathExpression = "<blueprint prefix unknown>";
        else if (prefix !== "") fullPath = `/${prefix}${path.startsWith("/") ? "" : "/"}${path}`;
      }
      route.properties.fullPath = fullPath;
      const handler = pending.handler ? resolve(pending.handler, fileId) : null;
      if (handler) {
        newRelationships.push({ from: route.id, to: handler, type: "ROUTE_HANDLED_BY", properties: {} });
        newRelationships.push({ from: route.id, to: handler, type: "ROUTE_LIFECYCLE_STEP", properties: { role: "handler", scope: "route", hook: "handler", orderIndex: 0 } });
      }
    }
    graph.addRelationships(newRelationships);
  },
};
