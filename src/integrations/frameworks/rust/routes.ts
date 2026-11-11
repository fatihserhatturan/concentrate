import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { rustAttributesOf, rustSplitArguments, type RustParsePlugin, type RustParsedFunction } from "../../languages/rust/parser.js";

// Rust HTTP routes, found at parse time from the router values a function
// builds: axum (`Router::new().route("/x", get(h))`), actix-web (`App::new()
// .service(..)`, `web::scope`, `web::resource`, `#[get("/x")]`), Rocket
// (`rocket::build().mount("/base", routes![a, b])`, `#[get("/x")]`) and warp
// (`warp::path!("a" / "b").and(warp::get()).and_then(h)`).
//
// A chain is evaluated into a Value: the routes it registers with their path
// below the value, and the mounts (a function returning a router, an
// attribute-routed function) whose paths the caller finishes. The values a
// function builds and does not hand to another chain become its routes; what
// crosses a call is finished once every file is parsed (route-mounts.ts).

export type RustRouteFramework = "axum" | "actix-web" | "rocket" | "warp";

// A reference to a handler, middleware or mounted function, in the shape of a
// Call node's properties so the Rust call resolver can find what it names.
export type RustRef = { expression: string; callee: string; receiver: null };

export type RustMount = {
  target: RustRef;
  prefix: string | null;
  // Outermost first.
  layerRefs: RustRef[];
  layers: string[];
  // "router": a function returning a router; "handler": a function carrying
  // its own route attribute.
  kind: "router" | "handler";
};

// What a Route keeps until route-mounts.ts finishes it.
export type RustPendingRoute = { handler: RustRef | null; layerRefs: RustRef[]; attribute?: true };

type Draft = {
  method: string | null;
  path: string | null;
  pathExpression: string | null;
  layerRefs: RustRef[];
  layers: string[];
  handler: RustRef | null;
  handlerName: string | null;
  // warp: the alternative ends in a handler.
  done: boolean;
  line: number;
  column: number;
  framework: RustRouteFramework;
};

type Value = {
  framework: RustRouteFramework;
  routes: Draft[];
  mounts: RustMount[];
  recognized: boolean;
  // actix `web::scope`: the prefix the children are below.
  scope?: { prefix: string | null };
  // actix `web::resource`: what its routes are registered at.
  resource?: { path: string | null; pathExpression: string | null; line: number; column: number; method: string | null };
};

const methodNames = new Map([["get", "GET"], ["post", "POST"], ["put", "PUT"], ["delete", "DELETE"], ["patch", "PATCH"], ["head", "HEAD"], ["options", "OPTIONS"], ["trace", "TRACE"], ["connect", "CONNECT"]]);
const frameworkCrates: Array<[RustRouteFramework, RegExp]> = [
  ["axum", /\baxum\b/u],
  ["actix-web", /\bactix_web\b/u],
  ["rocket", /\brocket\b/u],
  ["warp", /\bwarp\b/u],
];

export const rustRoutesPlugin: RustParsePlugin = (file) => {
  const { fileNodeId, root, nodes, relationships, functions } = file;
  if (/(^|[\\/])tests[\\/]/u.test(file.relativePath)) return;
  const source = root.text;
  const frameworks = new Set(frameworkCrates.filter(([, pattern]) => pattern.test(source)).map(([name]) => name));
  if (frameworks.size === 0) return;

  const constants = new Map<string, string>();
  for (const item of root.descendantsOfType("const_item")) {
    const name = item.childForFieldName("name")?.text;
    const value = item.childForFieldName("value");
    const literal = value ? stringLiteral(value) : null;
    if (name && literal !== null) constants.set(name, literal);
  }

  const dynamicCalls = new Map<string, { line: number; expression: string; framework: string }>();
  const usedIds = new Set<string>();
  const addRoute = (fn: RustParsedFunction, draft: Draft, scopeFunctionId: string, pending: RustPendingRoute) => {
    let id = `${fileNodeId}:route:${draft.line}:${draft.column}:${draft.method ?? "ALL"}:${draft.path ?? draft.pathExpression}`;
    for (let n = 1; usedIds.has(id); n += 1) id = `${id.replace(/#\d+$/u, "")}#${n}`;
    usedIds.add(id);
    const node: GraphNode = {
      id,
      label: "Route",
      properties: {
        method: draft.method ?? "ALL",
        path: draft.path,
        fullPath: null,
        pathExpression: draft.path === null ? draft.pathExpression : null,
        receiverName: null,
        line: draft.line,
        framework: draft.framework,
        handlerName: draft.handlerName,
        pendingHandlerRefs: null,
        scopeFunctionId,
        layers: draft.layers.length > 0 ? JSON.stringify(draft.layers) : null,
        rustPending: JSON.stringify(pending),
      },
    };
    nodes.push(node);
    relationships.push({ from: fileNodeId, to: node.id, type: "DECLARES_ROUTE", properties: {} });
  };

  // `#[get("/x")]` and `#[route("/x", method = "GET")]` on a function.
  for (const fn of functions) {
    if (fn.node.properties.testKind) continue;
    for (const attribute of rustAttributesOf(fn.syntax)) {
      const parsed = routeAttribute(attribute, frameworks, constants);
      if (!parsed) continue;
      const line = Number(fn.node.properties.line);
      for (const method of parsed.methods) {
        if (parsed.path === null) dynamicCalls.set(`${line}:${attribute.expression}`, { line, expression: attribute.expression, framework: parsed.framework });
        addRoute(fn, {
          method, path: parsed.path, pathExpression: parsed.pathExpression, layerRefs: [], layers: [], handler: null,
          handlerName: String(fn.node.properties.name), done: true, line, column: 0, framework: parsed.framework,
        }, fn.node.id, { handler: null, layerRefs: [], attribute: true });
      }
    }
  }

  for (const fn of functions) {
    if (fn.node.properties.testKind) continue;
    const body = fn.syntax.childForFieldName("body");
    if (!body) continue;
    const terminals = evaluateFunction(fn, body, frameworks, constants, dynamicCalls);
    const mounts: RustMount[] = [];
    for (const terminal of terminals) {
      for (const draft of terminal.routes) {
        if (!draft.done) continue;
        if (draft.handlerName === null && draft.handler === null && draft.method === null && draft.path === null) continue;
        addRoute(fn, draft, fn.node.id, { handler: draft.handler, layerRefs: draft.layerRefs });
      }
      mounts.push(...terminal.mounts);
    }
    if (mounts.length > 0) fn.node.properties.rustMounts = JSON.stringify(mounts);
  }

  if (dynamicCalls.size > 0) {
    const fileNode = nodes.find((node) => node.id === fileNodeId);
    if (fileNode) fileNode.properties.dynamicRouteCalls = JSON.stringify([...dynamicCalls.values()].sort((a, b) => a.line - b.line));
  }
};

type RouteAttribute = { framework: RustRouteFramework; methods: string[]; path: string | null; pathExpression: string | null };

function routeAttribute(attribute: { name: string; args: string[] }, frameworks: ReadonlySet<RustRouteFramework>, constants: ReadonlyMap<string, string>): RouteAttribute | null {
  const segments = attribute.name.split("::");
  const last = segments.at(-1)!;
  let framework: RustRouteFramework | null = null;
  if (segments.length > 1) {
    const qualifier = segments[0]!;
    framework = qualifier === "actix_web" ? "actix-web" : qualifier === "rocket" ? "rocket" : null;
  } else if (frameworks.has("actix-web") !== frameworks.has("rocket")) {
    framework = frameworks.has("actix-web") ? "actix-web" : "rocket";
  }
  if (!framework || !frameworks.has(framework)) return null;
  const literalOf = (text: string | undefined): [string | null, string | null] => {
    if (text === undefined) return [null, null];
    const value = stringLiteralText(text) ?? constants.get(text) ?? null;
    return [value, value === null ? text : null];
  };
  if (methodNames.has(last)) {
    const [value, expression] = literalOf(attribute.args[0]);
    return { framework, methods: [methodNames.get(last)!], path: value === null ? null : cleanRocketPath(framework, value), pathExpression: expression };
  }
  if (last === "route") {
    const methods: string[] = [];
    let path: string | null = null;
    let pathExpression: string | null = null;
    for (const arg of attribute.args) {
      const named = /^(\w+)\s*=\s*(.*)$/su.exec(arg);
      if (named?.[1] === "method") {
        const method = (stringLiteralText(named[2]!.trim()) ?? named[2]!.trim()).toUpperCase();
        methods.push(method);
      } else if (named?.[1] === "path") {
        [path, pathExpression] = literalOf(named[2]!.trim());
      } else if (!named && path === null && pathExpression === null) {
        [path, pathExpression] = literalOf(arg);
      } else if (!named && framework === "rocket") {
        methods.push(arg.trim().toUpperCase());
      }
    }
    if (framework === "rocket" && attribute.args[0] && !/=/u.test(attribute.args[0])) {
      methods.splice(0, methods.length, attribute.args[0].trim().toUpperCase());
    }
    if (methods.length === 0) methods.push("ALL");
    return { framework, methods, path: path === null ? null : cleanRocketPath(framework, path), pathExpression };
  }
  return null;
}

// Rocket's `/x?<q>` query part is not part of the path.
function cleanRocketPath(framework: RustRouteFramework, value: string): string {
  return framework === "rocket" ? value.replace(/\?.*$/u, "") : value;
}

function stringLiteralText(text: string): string | null {
  const plain = /^"((?:[^"\\]|\\.)*)"$/su.exec(text);
  if (plain) return plain[1]!.includes("\\") ? null : plain[1]!;
  const raw = /^r(#*)"(.*)"\1$/su.exec(text);
  return raw ? raw[2]! : null;
}

function stringLiteral(node: SyntaxNode): string | null {
  if (node.type === "reference_expression") {
    const value = node.childForFieldName("value");
    return value ? stringLiteral(value) : null;
  }
  return node.type === "string_literal" || node.type === "raw_string_literal" ? stringLiteralText(node.text) : null;
}

function join(base: string | null, relative: string | null): string | null {
  if (base === null || relative === null) return null;
  if (relative === "" || relative === "/") return base === "" ? "/" : base;
  const left = base === "/" ? "" : base.replace(/\/$/u, "");
  const right = relative.startsWith("/") ? relative : `/${relative}`;
  return `${left}${right}`;
}

function compact(text: string): string {
  return text.replace(/\s+/gu, "");
}

// `a::b::<T>::c` → `a::b::c`.
function pathText(node: SyntaxNode): string {
  let value = compact(node.text);
  for (let previous = ""; previous !== value;) {
    previous = value;
    value = value.replace(/::<[^<>]*>/gu, "");
  }
  return value;
}

function refOf(node: SyntaxNode | null): RustRef | null {
  if (!node) return null;
  let current: SyntaxNode = node;
  while (current.type === "reference_expression" || current.type === "parenthesized_expression" || current.type === "generic_function") {
    const next: SyntaxNode | null = current.type === "reference_expression" ? current.childForFieldName("value") : current.type === "generic_function" ? current.childForFieldName("function") : current.namedChildren[0] ?? null;
    if (!next) return null;
    current = next;
  }
  if (current.type !== "identifier" && current.type !== "scoped_identifier") return null;
  const expression = pathText(current);
  return { expression, callee: expression.split("::").at(-1)!, receiver: null };
}

function argsOf(call: SyntaxNode): SyntaxNode[] {
  return call.childForFieldName("arguments")?.namedChildren.filter((child) => child.type !== "line_comment" && child.type !== "block_comment") ?? [];
}

function clone(value: Value): Value {
  return { ...value, routes: value.routes.map((draft) => ({ ...draft })), mounts: value.mounts.map((mount) => ({ ...mount })) };
}

function prefixed(value: Value, prefix: string | null): Value {
  const next = clone(value);
  for (const draft of next.routes) draft.path = join(prefix, draft.path);
  for (const mount of next.mounts) mount.prefix = join(prefix, mount.prefix);
  return next;
}

function withLayers(value: Value, refs: RustRef[], names: string[]): Value {
  const next = clone(value);
  for (const draft of next.routes) {
    draft.layerRefs = [...refs, ...draft.layerRefs];
    draft.layers = [...names, ...draft.layers];
  }
  for (const mount of next.mounts) {
    mount.layerRefs = [...refs, ...mount.layerRefs];
    mount.layers = [...names, ...mount.layers];
  }
  return next;
}

function combine(left: Value, right: Value): Value {
  return { ...left, routes: [...left.routes, ...right.routes], mounts: [...left.mounts, ...right.mounts], recognized: left.recognized || right.recognized };
}

function empty(framework: RustRouteFramework, recognized = true): Value {
  return { framework, routes: [], mounts: [], recognized };
}

const routerParameterType = /\b(Router|ServiceConfig|Scope|App|Rocket)\b/u;

function evaluateFunction(
  fn: RustParsedFunction,
  body: SyntaxNode,
  frameworks: ReadonlySet<RustRouteFramework>,
  constants: ReadonlyMap<string, string>,
  dynamicCalls: Map<string, { line: number; expression: string; framework: string }>,
): Value[] {
  // What each local holds: its definitions, in order.
  const definitions = new Map<string, Array<{ value: SyntaxNode; line: number }>>();
  const returnsRouter = /\b(Router|Filter|Rocket|Route|ServiceConfig|Scope|App)\b|impl\s+Fn\(/u.test(String(fn.node.properties.returnType ?? ""));
  const parameterRoots = new Map<string, RustRouteFramework>();
  for (const parameter of fn.syntax.childForFieldName("parameters")?.namedChildren ?? []) {
    if (parameter.type !== "parameter") continue;
    const name = parameter.childForFieldName("pattern")?.text.replace(/^mut\s+/u, "");
    const type = parameter.childForFieldName("type")?.text ?? "";
    const match = routerParameterType.exec(type);
    if (!name || !match) continue;
    const framework: RustRouteFramework = match[1] === "Router" ? "axum" : match[1] === "Rocket" ? "rocket" : "actix-web";
    if (frameworks.has(framework)) parameterRoots.set(name, framework);
  }

  const walkBody = (node: SyntaxNode, visit: (node: SyntaxNode) => void) => {
    visit(node);
    for (const child of node.namedChildren) {
      if (child.type === "function_item") continue;
      walkBody(child, visit);
    }
  };
  walkBody(body, (node) => {
    if (node.type === "let_declaration") {
      const pattern = node.childForFieldName("pattern");
      const name = pattern?.type === "identifier" ? pattern.text : pattern?.type === "mut_pattern" ? pattern.namedChildren.find((child) => child.type === "identifier")?.text : undefined;
      const value = node.childForFieldName("value");
      if (name && value) definitions.set(name, [...definitions.get(name) ?? [], { value, line: node.startPosition.row }]);
    } else if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const value = node.childForFieldName("right");
      if (left?.type === "identifier" && value) definitions.set(left.text, [...definitions.get(left.text) ?? [], { value, line: node.startPosition.row }]);
    }
  });

  const consumed = new Set<string>();
  const key = (node: SyntaxNode) => `${node.startIndex}:${node.endIndex}`;
  const inLoop = (node: SyntaxNode) => {
    for (let parent = node.parent; parent && parent.id !== body.id; parent = parent.parent) {
      if (parent.type === "for_expression" || parent.type === "while_expression" || parent.type === "loop_expression") return true;
    }
    return false;
  };
  const dynamic = (call: SyntaxNode, framework: RustRouteFramework) => {
    const line = call.startPosition.row + 1;
    dynamicCalls.set(`${line}:${call.startPosition.column}`, { line, expression: compact(call.childForFieldName("function")?.text ?? call.text).slice(0, 120), framework });
  };

  const pathArgument = (node: SyntaxNode | undefined): { path: string | null; expression: string | null } => {
    if (!node) return { path: null, expression: null };
    const literal = stringLiteral(node);
    if (literal !== null) return { path: literal, expression: null };
    const name = node.type === "identifier" ? node.text : node.type === "scoped_identifier" ? node.childForFieldName("name")?.text : undefined;
    const constant = name ? constants.get(name) : undefined;
    return constant !== undefined ? { path: constant, expression: null } : { path: null, expression: node.text };
  };

  const layerSpec = (node: SyntaxNode | undefined): { refs: RustRef[]; names: string[] } => {
    const result = { refs: [] as RustRef[], names: [] as string[] };
    const visit = (current: SyntaxNode) => {
      if (current.type === "await_expression" || current.type === "try_expression" || current.type === "parenthesized_expression") {
        const inner = current.namedChildren[0];
        if (inner) visit(inner);
        return;
      }
      if (current.type === "tuple_expression") {
        current.namedChildren.forEach(visit);
        return;
      }
      if (current.type !== "call_expression") {
        const ref = refOf(current);
        result.names.push(compact(current.text).slice(0, 80));
        if (ref) result.refs.push(ref);
        return;
      }
      const callee = current.childForFieldName("function");
      if (callee?.type === "field_expression") {
        const method = callee.childForFieldName("field")?.text;
        const receiver = callee.childForFieldName("value");
        if (receiver && (method === "layer" || method === "wrap" || method === "with")) {
          // ServiceBuilder::new().layer(a).layer(b): `a` is the outermost.
          const before = { refs: result.refs.length, names: result.names.length };
          visit(receiver);
          const first = { refs: result.refs.slice(before.refs), names: result.names.slice(before.names) };
          result.refs.length = before.refs;
          result.names.length = before.names;
          result.refs.push(...first.refs);
          result.names.push(...first.names);
          for (const arg of argsOf(current)) visit(arg);
          return;
        }
        result.names.push(compact(current.text).slice(0, 80));
        return;
      }
      const text = callee ? pathText(callee) : "";
      result.names.push(compact(current.text).slice(0, 80));
      if (/(^|::)(from_fn|from_fn_with_state|from_extractor|from_extractor_with_state|map_request|map_response|map_request_with_state|map_response_with_state)$/u.test(text)) {
        const ref = refOf(argsOf(current).at(-1) ?? null);
        if (ref) result.refs.push(ref);
      }
    };
    if (node) visit(node);
    return result;
  };

  const lookup = (identifier: SyntaxNode): SyntaxNode | null => {
    const candidates = definitions.get(identifier.text) ?? [];
    let found: { value: SyntaxNode; line: number } | undefined;
    for (const candidate of candidates) {
      const contains = candidate.value.startIndex <= identifier.startIndex && candidate.value.endIndex >= identifier.endIndex;
      if (candidate.line <= identifier.startPosition.row && !contains) found = candidate;
    }
    return found?.value ?? null;
  };

  // axum `get(h).post(h2).layer(L)`, actix `web::get().to(h)`: the methods a
  // chain handles, each with its handler.
  const methodRouter = (node: SyntaxNode, framework: RustRouteFramework, depth = 0): Array<{ method: string; handler: RustRef | null; handlerName: string | null; layerRefs: RustRef[]; layers: string[] }> => {
    if (depth > 8) return [];
    if (node.type === "identifier") {
      const value = lookup(node);
      if (value) {
        consumed.add(key(value));
        return methodRouter(value, framework, depth + 1);
      }
      return [];
    }
    if (node.type === "reference_expression" || node.type === "parenthesized_expression" || node.type === "await_expression") {
      const inner = node.childForFieldName("value") ?? node.namedChildren[0];
      return inner ? methodRouter(inner, framework, depth + 1) : [];
    }
    if (node.type !== "call_expression") return [];
    const callee = node.childForFieldName("function");
    if (!callee) return [];
    const args = argsOf(node);
    const handlerOf = (arg: SyntaxNode | undefined) => ({ handler: refOf(arg ?? null), handlerName: arg ? (refOf(arg)?.expression ?? (arg.type === "closure_expression" ? "<closure>" : compact(arg.text).slice(0, 60))) : null });
    if (callee.type === "field_expression") {
      const method = callee.childForFieldName("field")?.text ?? "";
      const receiver = callee.childForFieldName("value");
      const before = receiver ? methodRouter(receiver, framework, depth + 1) : [];
      const bare = method.replace(/_service$/u, "");
      if (methodNames.has(bare) || bare === "any") {
        return [...before, { method: bare === "any" ? "ALL" : methodNames.get(bare)!, ...handlerOf(args[0]), layerRefs: [], layers: [] }];
      }
      if (method === "on" || method === "on_service") {
        const filter = /(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)/u.exec(args[0]?.text ?? "")?.[1] ?? "ALL";
        return [...before, { method: filter, ...handlerOf(args[1]), layerRefs: [], layers: [] }];
      }
      if (method === "to" && framework === "actix-web") {
        // `web::get().to(h)`: the handler of the route the receiver names.
        return before.map((entry) => ({ ...entry, ...handlerOf(args[0]) }));
      }
      if (method === "layer" || method === "route_layer" || method === "wrap") {
        const spec = layerSpec(args[0]);
        return before.map((entry) => ({ ...entry, layerRefs: [...spec.refs, ...entry.layerRefs], layers: [...spec.names, ...entry.layers] }));
      }
      return before;
    }
    const text = pathText(callee);
    const last = text.split("::").at(-1)!;
    const bare = last.replace(/_service$/u, "");
    if (framework === "actix-web" && /(^|::)web$|^web::/u.test(text.split("::").slice(0, -1).join("::")) || framework === "actix-web" && text.startsWith("web::")) {
      if (methodNames.has(last)) return [{ method: methodNames.get(last)!, handler: null, handlerName: null, layerRefs: [], layers: [] }];
      if (last === "route") return [{ method: "ALL", handler: null, handlerName: null, layerRefs: [], layers: [] }];
      if (last === "method") {
        const filter = /(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)/u.exec(args[0]?.text ?? "")?.[1] ?? "ALL";
        return [{ method: filter, handler: null, handlerName: null, layerRefs: [], layers: [] }];
      }
    }
    // `use actix_web::web::{get, post}` then `get().to(h)`: the web:: free
    // functions called bare. They take no arguments, which tells them from axum's `get(h)`.
    if (framework === "actix-web" && !text.includes("::") && args.length === 0 && methodNames.has(last)) {
      return [{ method: methodNames.get(last)!, handler: null, handlerName: null, layerRefs: [], layers: [] }];
    }
    if (framework === "axum" && (methodNames.has(bare) || bare === "any")) {
      return [{ method: bare === "any" ? "ALL" : methodNames.get(bare)!, ...handlerOf(args[0]), layerRefs: [], layers: [] }];
    }
    if (framework === "axum" && (last === "on" || last === "on_service")) {
      const filter = /(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)/u.exec(args[0]?.text ?? "")?.[1] ?? "ALL";
      return [{ method: filter, ...handlerOf(args[1]), layerRefs: [], layers: [] }];
    }
    return [];
  };

  const draftOf = (framework: RustRouteFramework, method: string | null, path: string | null, pathExpression: string | null, line: SyntaxNode, entry?: { handler: RustRef | null; handlerName: string | null; layerRefs: RustRef[]; layers: string[] }): Draft => ({
    method, path, pathExpression, layerRefs: entry?.layerRefs ?? [], layers: entry?.layers ?? [],
    handler: entry?.handler ?? null, handlerName: entry?.handlerName ?? null, done: true,
    line: line.startPosition.row + 1, column: line.startPosition.column, framework,
  });

  const evaluate = (node: SyntaxNode, depth = 0, top = false): Value | null => {
    if (depth > 24) return null;
    if (!top) consumed.add(key(node));
    switch (node.type) {
      case "parenthesized_expression":
      case "await_expression":
      case "try_expression":
      case "reference_expression": {
        const inner = node.childForFieldName("value") ?? node.namedChildren[0];
        return inner ? evaluate(inner, depth + 1) : null;
      }
      case "block": {
        const last = node.namedChildren.at(-1);
        return last && last.type !== "expression_statement" && last.type !== "let_declaration" ? evaluate(last, depth + 1) : null;
      }
      case "identifier": {
        const value = lookup(node);
        if (value) return evaluate(value, depth + 1);
        const framework = parameterRoots.get(node.text);
        return framework ? empty(framework) : handlerMount(node);
      }
      case "macro_invocation":
        return evaluateMacro(node, depth);
      case "tuple_expression": {
        let merged: Value | null = null;
        for (const child of node.namedChildren) {
          const value = evaluate(child, depth + 1);
          if (value) merged = merged ? combine(merged, value) : value;
        }
        return merged;
      }
      case "call_expression":
        return evaluateCall(node, depth);
      case "scoped_identifier":
      case "generic_function":
        return handlerMount(node);
      default:
        return null;
    }
  };

  // `routes![a, b]`, `warp::path!("a" / "b")`.
  const evaluateMacro = (node: SyntaxNode, depth: number): Value | null => {
    const name = pathText(node.childForFieldName("macro") ?? node);
    const last = name.split("::").at(-1)!;
    const tokens = node.namedChildren.find((child) => child.type === "token_tree");
    if (last === "routes" && frameworks.has("rocket")) {
      const value = empty("rocket");
      for (const part of rustSplitArguments(tokens?.text.slice(1, -1) ?? "")) {
        const expression = compact(part);
        if (!/^[\w:]+$/u.test(expression)) continue;
        const target = { expression, callee: expression.split("::").at(-1)!, receiver: null };
        value.mounts.push({ target, prefix: "", layerRefs: [], layers: [], kind: "handler" });
      }
      return value;
    }
    if (last === "path" && name.endsWith("path") && frameworks.has("warp") && node.childForFieldName("macro")) {
      const segments = warpPathMacro(tokens?.text.slice(1, -1) ?? "");
      const value = empty("warp");
      value.routes.push({ ...draftOf("warp", null, segments, null, node), done: false });
      return value;
    }
    return null;
  };

  // A function a chain mentions without calling: what `service(h)` takes.
  const handlerMount = (node: SyntaxNode): Value | null => {
    const ref = refOf(node);
    if (!ref || !(frameworks.has("actix-web"))) return null;
    const value = empty("actix-web");
    value.mounts.push({ target: ref, prefix: "", layerRefs: [], layers: [], kind: "handler" });
    return value;
  };

  const evaluateCall = (node: SyntaxNode, depth: number): Value | null => {
    const callee = node.childForFieldName("function");
    if (!callee) return null;
    const args = argsOf(node);
    if (callee.type === "field_expression") return evaluateMethod(node, callee, args, depth);
    const text = pathText(callee.type === "generic_function" ? (callee.childForFieldName("function") ?? callee) : callee);
    const last = text.split("::").at(-1)!;

    if (frameworks.has("axum") && /(^|::)Router::new$/u.test(text)) return empty("axum");
    if (frameworks.has("actix-web") && (/(^|::)App::new$/u.test(text) || /(^|::)Scope::new$/u.test(text))) return empty("actix-web");
    if (frameworks.has("actix-web") && /(^|::)(web::)?scope$/u.test(text)) {
      const { path } = pathArgument(args[0]);
      const value = empty("actix-web");
      value.scope = { prefix: path };
      if (path === null) dynamic(node, "actix-web");
      return value;
    }
    if (frameworks.has("actix-web") && /(^|::)(web::)?resource$/u.test(text)) {
      const { path, expression } = pathArgument(args[0]);
      const value = empty("actix-web");
      value.resource = { path, pathExpression: expression, line: node.startPosition.row + 1, column: node.startPosition.column, method: null };
      if (path === null) dynamic(node, "actix-web");
      return value;
    }
    if (frameworks.has("rocket") && /(^|::)(rocket::)?(build|custom|ignite)$|(^|::)Rocket::(build|custom)$/u.test(text)) return empty("rocket");
    if (frameworks.has("warp") && /^(warp::)?(any|get|post|put|delete|patch|head|options)$/u.test(text) && (text.startsWith("warp::") || frameworks.size === 1)) {
      const value = empty("warp");
      value.routes.push({ ...draftOf("warp", methodNames.get(last) ?? null, "", null, node), done: false });
      return value;
    }
    if (frameworks.has("warp") && /(^|::)warp::path$/u.test(text)) {
      const { path, expression } = pathArgument(args[0]);
      const value = empty("warp");
      if (path === null) dynamic(node, "warp");
      value.routes.push({ ...draftOf("warp", null, path === null ? null : join("", path), expression, node), done: false });
      return value;
    }
    if (frameworks.has("warp") && /(^|::)warp::path::(end|full|peek)$/u.test(text)) {
      const value = empty("warp");
      value.routes.push({ ...draftOf("warp", null, "", null, node), done: false });
      return value;
    }
    if (frameworks.has("warp") && /(^|::)warp::path::(param|tail)$/u.test(text)) {
      const value = empty("warp");
      value.routes.push({ ...draftOf("warp", null, last === "tail" ? "/*tail" : "/:param", null, node), done: false });
      return value;
    }
    if (frameworks.has("warp") && /(^|::)warp::(body|query|header|cookie|filters)::/u.test(text)) {
      const value = empty("warp");
      value.routes.push({ ...draftOf("warp", null, "", null, node), done: false });
      return value;
    }
    // A call of one of the project's functions: it may return a router.
    const ref = refOf(callee);
    if (ref && !/^(Some|Ok|Err|Box::new|Arc::new)$/u.test(text)) {
      const framework = [...frameworks][0]!;
      const value = empty(framework, false);
      value.mounts.push({ target: ref, prefix: "", layerRefs: [], layers: [], kind: "router" });
      return value;
    }
    return null;
  };

  const evaluateMethod = (node: SyntaxNode, callee: SyntaxNode, args: SyntaxNode[], depth: number): Value | null => {
    const method = callee.childForFieldName("field")?.text ?? "";
    const receiver = callee.childForFieldName("value");
    if (!receiver) return null;
    const base = evaluate(receiver, depth + 1);
    if (!base) return null;
    const framework = base.framework;
    const at = callee.childForFieldName("field") ?? node;

    // Any other method (`with_state`, `fallback`, `attach`, `boxed`…) leaves the value as it is.
    if (framework === "axum") {
      if (method === "route" || method === "route_service") {
        const { path, expression } = pathArgument(args[0]);
        if (path === null) {
          dynamic(node, "axum");
          return base;
        }
        const handlers = method === "route_service"
          ? [{ method: "ALL", handler: null, handlerName: compact(args[1]?.text ?? "").slice(0, 60) || null, layerRefs: [] as RustRef[], layers: [] as string[] }]
          : args[1] ? methodRouter(args[1], "axum") : [];
        const next = clone(base);
        for (const entry of handlers) next.routes.push(draftOf("axum", entry.method, path, expression, at, entry));
        return next;
      }
      if (method === "nest" || method === "nest_service") {
        const { path } = pathArgument(args[0]);
        const inner = args[1] ? evaluate(args[1], depth + 1) : null;
        if (path === null) {
          dynamic(node, "axum");
          return inner ? combine(base, prefixed(inner, null)) : base;
        }
        return inner ? combine(base, prefixed(finalize(inner), path)) : base;
      }
      if (method === "merge") {
        const inner = args[0] ? evaluate(args[0], depth + 1) : null;
        return inner ? combine(base, finalize(inner)) : base;
      }
      if (method === "layer" || method === "route_layer") {
        const spec = layerSpec(args[0]);
        return withLayers(base, spec.refs, spec.names);
      }
      return base;
    }

    if (framework === "actix-web") {
      if (method === "service") {
        let next = base;
        const inner = args[0] ? evaluate(args[0], depth + 1) : null;
        if (inner) next = combine(next, finalize(inner));
        return next;
      }
      if (method === "route") {
        if (args.length >= 2 && !base.resource) {
          const { path, expression } = pathArgument(args[0]);
          if (path === null) {
            dynamic(node, "actix-web");
            return base;
          }
          const next = clone(base);
          for (const entry of methodRouter(args[1]!, "actix-web")) next.routes.push(draftOf("actix-web", entry.method, path, expression, at, entry));
          return next;
        }
        if (base.resource) {
          const next = clone(base);
          for (const entry of methodRouter(args[0]!, "actix-web")) next.routes.push(draftOf("actix-web", entry.method, base.resource.path, base.resource.pathExpression, at, entry));
          return next;
        }
        return base;
      }
      if (method === "to" && base.resource) {
        const next = clone(base);
        const handler = refOf(args[0] ?? null);
        next.routes.push(draftOf("actix-web", base.resource.method, base.resource.path, base.resource.pathExpression, at, {
          handler, handlerName: handler?.expression ?? (args[0]?.type === "closure_expression" ? "<closure>" : compact(args[0]?.text ?? "").slice(0, 60)), layerRefs: [], layers: [],
        }));
        return next;
      }
      if (method === "guard" && base.resource) {
        const guard = /(?:^|::)(Get|Post|Put|Delete|Patch|Head|Options|Trace)\b/u.exec(compact(args[0]?.text ?? ""))?.[1];
        return guard ? { ...base, resource: { ...base.resource, method: guard.toUpperCase() } } : base;
      }
      if (method === "configure") {
        const ref = refOf(args[0] ?? null);
        if (!ref) return base;
        const next = clone(base);
        next.mounts.push({ target: ref, prefix: "", layerRefs: [], layers: [], kind: "router" });
        return next;
      }
      if (method === "wrap") {
        const spec = layerSpec(args[0]);
        return withLayers(base, spec.refs, spec.names);
      }
      return base;
    }

    if (framework === "rocket") {
      if (method === "mount") {
        const { path } = pathArgument(args[0]);
        const inner = args[1] ? evaluate(args[1], depth + 1) : null;
        if (path === null) dynamic(node, "rocket");
        return inner ? combine(base, prefixed(inner, path)) : base;
      }
      return base;
    }

    // warp filters.
    if (method === "and" || method === "or" || method === "or_else") {
      const right = args[0] ? evaluate(args[0], depth + 1) : null;
      if (!right) return base;
      if (method !== "and") return combine(base, right);
      if (right.routes.length === 0) {
        const kept = clone(base);
        kept.recognized = base.recognized || right.recognized;
        for (const mount of right.mounts) {
          if (base.routes.length === 0) kept.mounts.push(mount);
          for (const left of base.routes) kept.mounts.push({ ...mount, prefix: join(left.path ?? "", mount.prefix) });
        }
        return kept;
      }
      const next = empty("warp");
      next.recognized = base.recognized || right.recognized;
      next.mounts.push(...base.mounts);
      for (const left of base.routes) {
        for (const alt of right.routes) {
          next.routes.push({
            ...alt,
            method: alt.method ?? left.method,
            path: left.path === null || alt.path === null ? null : join(left.path, alt.path),
            pathExpression: left.pathExpression ?? alt.pathExpression,
            layerRefs: [...left.layerRefs, ...alt.layerRefs], layers: [...left.layers, ...alt.layers],
            done: alt.done || left.done,
            handler: alt.handler ?? left.handler, handlerName: alt.handlerName ?? left.handlerName,
          });
        }
        for (const mount of right.mounts) next.mounts.push({ ...mount, prefix: join(left.path ?? "", mount.prefix) });
      }
      if (base.routes.length === 0) {
        next.routes.push(...right.routes);
        next.mounts.push(...right.mounts);
      }
      return next;
    }
    if (method === "and_then" || method === "map" || method === "then" || method === "map_async") {
      const next = clone(base);
      const handler = refOf(args[0] ?? null);
      const name = handler?.expression ?? (args[0]?.type === "closure_expression" ? "<closure>" : compact(args[0]?.text ?? "").slice(0, 60));
      for (const draft of next.routes) {
        if (draft.done && draft.handlerName !== null) continue;
        draft.done = true;
        draft.handler = handler;
        draft.handlerName = name;
      }
      return next;
    }
    if (method === "with" || method === "layer") {
      const spec = layerSpec(args[0]);
      return withLayers(base, spec.refs, spec.names);
    }
    return base;
  };

  // A scope or resource handed to its parent is below its prefix.
  const finalize = (value: Value): Value => (value.scope ? prefixed({ ...value, scope: undefined }, value.scope.prefix) : value);

  // Maximal chains of the body: the outermost call expression of each, the
  // function's tail and what it returns.
  const candidates: Array<{ node: SyntaxNode; value: Value }> = [];
  const lastStatement = body.namedChildren.at(-1);
  walkBody(body, (node) => {
    const isIdentifierResult = node.type === "identifier" && (node.parent?.type === "return_expression" || (node.id === lastStatement?.id));
    if (node.type !== "call_expression" && node.type !== "macro_invocation" && !isIdentifierResult) return;
    const parent = node.parent;
    if (parent?.type === "field_expression" && parent.childForFieldName("value")?.id === node.id) return;
    const value = evaluate(node, 0, true);
    if (value) candidates.push({ node, value });
  });

  const terminals: Value[] = [];
  for (const { node, value } of candidates) {
    if (node.type !== "identifier" && consumed.has(key(node))) continue;
    if (value.routes.length === 0 && value.mounts.length === 0) continue;
    if (!value.recognized && !(returnsRouter && isTail(node, body))) continue;
    terminals.push(finalize(value));
  }
  return terminals;
}

// The chain is the function's tail or a `return`.
function isTail(node: SyntaxNode, body: SyntaxNode): boolean {
  const last = body.namedChildren.at(-1);
  if (last && (last.id === node.id)) return true;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "return_expression") return true;
    if (parent.id === body.id) return last?.id === node.id;
  }
  return false;
}

// `"a" / "b" / u32 / "c"` → `/a/b/:u32/c`.
function warpPathMacro(text: string): string {
  const segments = text.split("/").map((part) => part.trim()).filter((part) => part !== "");
  const parts = segments.map((segment) => {
    const literal = stringLiteralText(segment);
    if (literal !== null) return literal;
    if (segment === "..") return "*tail";
    return `:${segment.replace(/\s+/gu, "").split("::").at(-1)!.toLowerCase()}`;
  });
  return `/${parts.join("/")}`;
}
