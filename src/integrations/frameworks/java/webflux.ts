import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";
import { annotationValue, addJavaRoute, joinRoutePath } from "./annotations.js";
import { javaMethods } from "./shared.js";

// Spring WebFlux functional routes. A router is a method returning `RouterFunction<…>` (a `@Bean`
// or a helper one) built with
//   route(GET("/x"), handler::m).andRoute(POST("/x"), …).andNest(path("/api"), route(…))
//   route().GET("/x", handler::m).path("/api", b -> b.POST("/y", …)).nest(path("/z"), …).build()
// with `RouterFunctions.route`, `RequestPredicates.GET` … written qualified or imported statically.
//
// Two stages. The parse plugin reads what only the syntax holds (argument literals, the nesting of
// `nest`/`path`, the handler expression) and keeps one JSON record per route on the Function node
// (`javaWebfluxRoutes`). The contributor runs after the call resolver: a method reference
// `handler::m` (or a lambda that only calls `handler.m(request)`) is a Call node the resolver already
// typed from the receiver's declared type, so the handler is whatever that call resolves to. The
// record property is removed once read.
//
// Why a plugin on methods returning `RouterFunction` rather than a contributor over Call nodes: Call
// nodes keep neither the argument text nor the nesting. Why that return type and not `@Bean`: the
// router is built wherever a `RouterFunction` is returned (helper methods composed by another
// bean), and a `@Bean` returning anything else does not build routes.
//
// What stays out, never guessed: a nested router in another method (`nest(path("/a"), other())`: its
// routes get no prefix), a predicate held in a variable or built by a helper (route with no path,
// `pathExpression` the text), a handler that is not a method reference or a delegating lambda (Route
// with no handler).

const FRAMEWORK = "spring-webflux";
const PACKAGE = "org.springframework.web.reactive.function.server";
const VERBS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
// RequestPredicates that narrow a request without naming a path or method.
const NEUTRAL_PREDICATES = new Set(["accept", "contentType", "headers", "queryParam", "param", "pathExtension", "all"]);
const MAX_ALTERNATIVES = 8;

type Part = { text: string; resolved: boolean };
type Alternative = { method: string | null; path: Part | null; opaque: boolean };
type Context = { parts: Part[]; method: string | null };
type HandlerRef = { kind: "ref" | "call"; line: number; column: number; name: string } | { kind: "none" };
type RouteRecord = { method: string; path: string | null; pathExpression: string | null; line: number; handler: HandlerRef };

const isComment = (node: SyntaxNode) => node.type.endsWith("comment");
const argsOf = (call: SyntaxNode): SyntaxNode[] => call.childForFieldName("arguments")?.namedChildren.filter((child) => !isComment(child)) ?? [];
const compactText = (node: SyntaxNode): string => node.text.replace(/\s+/gu, " ").trim();
// `RequestPredicates.GET`, `org.…server.RequestPredicates.GET` or a bare static import.
const isPredicateScope = (object: SyntaxNode | null): boolean => object === null || /(?:^|\.)RequestPredicates$/u.test(object.text.replace(/\s+/gu, ""));

function partOf(node: SyntaxNode): Part {
  const [value] = annotationValue({ args: [node.text] }) ?? [];
  return value ? { text: value.value, resolved: value.resolved } : { text: compactText(node), resolved: false };
}

function unwrap(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.type === "parenthesized_expression" && current.namedChildren[0]) current = current.namedChildren[0];
  return current;
}

// The alternatives a predicate stands for: `GET("/a").and(accept(JSON))` is one (GET, /a), `GET("/a").or(GET("/b"))` two.
function evaluatePredicate(raw: SyntaxNode): Alternative[] {
  const node = unwrap(raw);
  const opaque: Alternative[] = [{ method: null, path: null, opaque: true }];
  if (node.type !== "method_invocation") return opaque;
  const name = node.childForFieldName("name")?.text ?? "";
  const object = node.childForFieldName("object");
  const args = argsOf(node);
  if (name === "and" && object && args.length === 1) {
    const results: Alternative[] = [];
    for (const left of evaluatePredicate(object)) {
      for (const right of evaluatePredicate(args[0]!)) {
        if (left.method && right.method && left.method !== right.method) return opaque;
        const path = left.path && right.path ? { text: compactText(node), resolved: false } : left.path ?? right.path;
        results.push({ method: left.method ?? right.method, path, opaque: left.opaque || right.opaque });
      }
    }
    return results.length > 0 && results.length <= MAX_ALTERNATIVES ? results : opaque;
  }
  if (name === "or" && object && args.length === 1) {
    const results = [...evaluatePredicate(object), ...evaluatePredicate(args[0]!)];
    return results.length <= MAX_ALTERNATIVES ? results : opaque;
  }
  if (!isPredicateScope(object)) return opaque;
  if (VERBS.has(name) && args.length === 1) return [{ method: name, path: partOf(args[0]!), opaque: false }];
  if (name === "path" && args.length === 1) return [{ method: null, path: partOf(args[0]!), opaque: false }];
  if (name === "method" && args.length === 1) {
    const written = args[0]!.text.replace(/\s+/gu, "").split(".").at(-1)!;
    return VERBS.has(written) ? [{ method: written, path: null, opaque: false }] : opaque;
  }
  if (NEUTRAL_PREDICATES.has(name)) return [{ method: null, path: null, opaque: false }];
  return opaque;
}

// A builder verb's first argument is the path (`"/x"`, `BASE + "/x"`, a constant) or a RequestPredicate.
function evaluateBuilderTarget(node: SyntaxNode): Alternative[] {
  const target = unwrap(node);
  if (target.type === "string_literal" || target.type === "binary_expression") return [{ method: null, path: partOf(target), opaque: false }];
  if (target.type === "method_invocation") return evaluatePredicate(target);
  // A constant naming the path (`USERS_PATH`) or a predicate variable: kept as written, never resolved.
  return [{ method: null, path: { text: compactText(target), resolved: false }, opaque: false }];
}

function describePath(parts: readonly Part[]): { path: string | null; pathExpression: string | null } {
  if (parts.every((part) => part.resolved)) return { path: joinRoutePath(...parts.map((part) => part.text)), pathExpression: null };
  return { path: null, pathExpression: parts.filter((part) => part.text !== "").map((part) => (part.resolved ? JSON.stringify(part.text) : part.text)).join(" + ") };
}

// The handler of a route: a method reference, or a lambda whose whole body is `x.m(request)`.
function handlerOf(raw: SyntaxNode | undefined): HandlerRef {
  if (!raw) return { kind: "none" };
  const node = unwrap(raw);
  if (node.type === "method_reference") {
    const name = node.children.at(-1)?.text ?? "";
    return name === "new" || name === "" ? { kind: "none" } : { kind: "ref", line: node.startPosition.row + 1, column: node.startPosition.column, name };
  }
  if (node.type !== "lambda_expression") return { kind: "none" };
  const parameters = node.childForFieldName("parameters");
  const names = parameters?.type === "identifier" ? [parameters.text]
    : (parameters?.namedChildren ?? []).map((child) => child.type === "identifier" ? child.text : child.childForFieldName("name")?.text ?? "");
  if (names.length !== 1 || names[0] === "") return { kind: "none" };
  let body = node.childForFieldName("body");
  if (body?.type === "block") {
    const statements = body.namedChildren.filter((child) => !isComment(child));
    body = statements.length === 1 && statements[0]!.type === "return_statement" ? statements[0]!.namedChildren.find((child) => !isComment(child)) ?? null : null;
  }
  const call = body ? unwrap(body) : null;
  if (!call || call.type !== "method_invocation" || !call.childForFieldName("object")) return { kind: "none" };
  const args = argsOf(call);
  if (args.length !== 1 || args[0]!.type !== "identifier" || args[0]!.text !== names[0]) return { kind: "none" };
  return { kind: "call", line: call.startPosition.row + 1, column: call.startPosition.column, name: call.childForFieldName("name")?.text ?? "" };
}

function routesOf(body: SyntaxNode): RouteRecord[] {
  const routes: RouteRecord[] = [];
  const emit = (call: SyntaxNode, alternatives: Alternative[], handler: SyntaxNode | undefined, context: Context): void => {
    const line = (call.childForFieldName("name") ?? call).startPosition.row + 1;
    const handlerRef = handlerOf(handler);
    for (const alternative of alternatives) {
      const parts = [...context.parts, ...(alternative.path ? [alternative.path] : [])];
      // A predicate held in a variable or built by a helper: the path is not visible.
      if (alternative.opaque && !alternative.path) parts.push({ text: compactText(call.childForFieldName("arguments")?.namedChildren[0] ?? call), resolved: false });
      routes.push({ method: alternative.method ?? context.method ?? "ALL", ...describePath(parts), line, handler: handlerRef });
    }
  };
  const visitAll = (nodes: readonly SyntaxNode[], context: Context): void => {
    for (const node of nodes) visit(node, context);
  };
  const nested = (predicate: SyntaxNode, inner: SyntaxNode | undefined, context: Context): void => {
    if (!inner) return;
    for (const alternative of evaluatePredicate(predicate)) {
      const parts = alternative.opaque && !alternative.path ? [...context.parts, { text: compactText(predicate), resolved: false }] : [...context.parts, ...(alternative.path ? [alternative.path] : [])];
      visit(inner, { parts, method: alternative.method ?? context.method });
    }
  };
  function visit(node: SyntaxNode, context: Context): void {
    // Types declared inside have their own methods.
    if (node.type.endsWith("_declaration") && node.type !== "local_variable_declaration") return;
    if (node.type === "class_body") return;
    if (node.type !== "method_invocation") {
      visitAll(node.namedChildren, context);
      return;
    }
    const name = node.childForFieldName("name")?.text ?? "";
    const object = node.childForFieldName("object");
    const args = argsOf(node);
    if (object) visit(object, context);
    if ((name === "route" || name === "andRoute") && args.length === 2) {
      emit(node, evaluatePredicate(args[0]!), args[1], context);
      visitAll(args.slice(1), context);
    } else if (VERBS.has(name) && object && !isPredicateScope(object) && args.length >= 1) {
      const target = args.length >= 2 && args[0] ? evaluateBuilderTarget(args[0]) : [{ method: null, path: null, opaque: false }];
      emit(node, target.map((alternative) => ({ ...alternative, method: name })), args.at(-1), context);
    } else if ((name === "nest" || name === "andNest") && args.length === 2) {
      nested(args[0]!, args[1], context);
    } else if (name === "path" && object && args.length === 2) {
      // The builder's `.path("/api", b -> …)`; the one-argument `path("/api")` is a predicate.
      for (const alternative of evaluateBuilderTarget(args[0]!)) {
        visit(args[1]!, { parts: [...context.parts, ...(alternative.path ? [alternative.path] : [])], method: context.method });
      }
    } else {
      visitAll(args, context);
    }
  }
  visit(body, { parts: [], method: null });
  return routes;
}

export const javaWebfluxPlugin: JavaParsePlugin = ({ root, functions }) => {
  if (!root.text.includes(PACKAGE)) return;
  for (const { syntax, node } of functions) {
    if (!/(?:^|\.)RouterFunction\b/u.test(String(node.properties.returnType ?? ""))) continue;
    const body = syntax.childForFieldName("body");
    if (!body) continue;
    const routes = routesOf(body);
    if (routes.length > 0) node.properties.javaWebfluxRoutes = JSON.stringify(routes);
  }
};

const simpleType = (type: string): string => type.replace(/<.*$/su, "").split(".").at(-1) ?? type;

export const javaWebfluxContributor: ISemanticContributor = {
  id: "java.webflux",
  contribute(graph) {
    const routers = graph.nodesWithLabel("Function").filter((node) => typeof node.properties.javaWebfluxRoutes === "string");
    if (routers.length === 0) return;
    const fileOf = new Map(javaMethods(graph).map((method) => [method.node.id, method.fileId]));
    const callsByFunction = new Map<string, Map<string, GraphNode>>();
    for (const rel of graph.relationshipsOfType("CALLS")) {
      const call = graph.node(rel.to);
      if (!call || call.label !== "Call") continue;
      let calls = callsByFunction.get(rel.from);
      if (!calls) callsByFunction.set(rel.from, calls = new Map());
      calls.set(`${String(call.properties.line)}:${String(call.properties.columnNumber)}:${String(call.properties.callKind)}`, call);
    }
    const targetsOf = new Map<string, Array<{ fn: GraphNode; via: unknown }>>();
    for (const rel of graph.relationshipsOfType("CALL_RESOLVES_TO")) {
      const fn = graph.node(rel.to);
      if (!fn) continue;
      const list = targetsOf.get(rel.from);
      if (list) list.push({ fn, via: rel.properties.via });
      else targetsOf.set(rel.from, [{ fn, via: rel.properties.via }]);
    }
    // The one method a handler call names: the declared one (overriding subtypes are not the handler),
    // or among overloads the one taking a ServerRequest.
    const handlerTarget = (call: GraphNode | undefined): GraphNode | null => {
      const targets = targetsOf.get(call?.id ?? "") ?? [];
      const exact = targets.filter((target) => target.via === undefined || target.via === null);
      const overloads = targets.filter((target) => target.via === "overload");
      if (exact.length === 1 && overloads.length === 0) return exact[0]!.fn;
      if (exact.length === 0 && overloads.length > 0) {
        const takesRequest = overloads.filter((target) => {
          try {
            const parameters = JSON.parse(String(target.fn.properties.parameters ?? "[]")) as Array<{ type?: string }>;
            return parameters.length >= 1 && simpleType(parameters[0]?.type ?? "") === "ServerRequest";
          } catch {
            return false;
          }
        });
        if (takesRequest.length === 1) return takesRequest[0]!.fn;
      }
      return null;
    };
    for (const router of routers) {
      const records = JSON.parse(String(router.properties.javaWebfluxRoutes)) as RouteRecord[];
      delete router.properties.javaWebfluxRoutes;
      const fileId = fileOf.get(router.id);
      if (!fileId) continue;
      const calls = callsByFunction.get(router.id);
      for (const record of records) {
        let handler: GraphNode | null = null;
        let handlerName: string | null = null;
        if (record.handler.kind !== "none") {
          const call = calls?.get(`${record.handler.line}:${record.handler.column}:${record.handler.kind === "ref" ? "methodReference" : "method"}`);
          handler = handlerTarget(call);
          // A named method reference is a fact even when the method is outside the scan; a lambda's callee is not the handler's name.
          if (!handler && record.handler.kind === "ref") handlerName = record.handler.name;
        }
        addJavaRoute(graph, { fileId, method: record.method, path: record.path, pathExpression: record.pathExpression, framework: FRAMEWORK, line: record.line, handler, handlerName });
      }
    }
  },
};
