import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { analyzeMemberCallExpression, walkScoped } from "../../languages/tree-sitter-utils.js";
import { goParameters, localTypes, type GoParsePlugin, type LocalType } from "../../languages/go/parser.js";
import { addClosures, closureFunctionNode } from "./closures.js";

// Go HTTP routes, found at parse time from the routers a function builds,
// receives or returns: `r := gin.Default()`, `mux := http.NewServeMux()`, a
// group (`v1 := r.Group("/api")`, `r.Route("/users", func(r chi.Router) {…})`)
// or a parameter typed as a router (`func Register(router *gin.RouterGroup)`).
// Each registration (`router.GET("/feed", h)`, `mux.HandleFunc("GET /x/{id}", h)`)
// becomes a Route with the path known in its function. What crosses a call (a
// group passed to another function, a router a function returns and the
// caller mounts) and handler references are finished once every file is
// parsed (route-mounts.ts).

export type GoRouteFramework = "gin" | "echo" | "chi" | "fiber" | "gorilla/mux" | "net/http";

// A reference to a handler or middleware, in the shape of a Call node's
// properties so the Go call resolver can find the function it names; a
// closure is the Function made for it.
export type GoHandlerRef = {
  expression: string;
  callee: string;
  receiver: string | null;
  receiverType?: string;
  receiverConstructor?: string;
  receiverIsLocal?: true;
  // A call that returns the handler (`AuthMiddleware(true)`): the step is
  // the function called, and `call` the call as written.
  factory?: true;
  call?: string;
  functionId?: string;
  // "router" for middleware a router or group applies, "route" for the
  // registration's own.
  scope: "router" | "route";
};

// Where a router of a function comes from when the function cannot see its
// path: one of its parameters (the index), or its result (RETURNED_ROUTER),
// which a caller may mount.
export const RETURNED_ROUTER = -1;

// What a Route keeps until route-mounts.ts finishes it: where its router came
// from (its path and middleware are known at the call sites), the path below
// that router and the handler and middleware references.
export type GoPendingRoute = {
  base: number | null;
  path: string | null;
  middleware: GoHandlerRef[];
  handler: GoHandlerRef | null;
};

// A router passed to a function (`index` the argument), a router a called
// function returns mounted by the caller (`index` RETURNED_ROUTER), or a
// router handed to a named callback (`r.Route("/admin", adminRoutes)`,
// `callback`, parameter 0), kept on the Call node: its path and middleware,
// and where the caller's own router came from.
export type GoRouterArgument = {
  index: number;
  prefix: string | null;
  base: number | null;
  middleware: GoHandlerRef[];
  callback?: GoHandlerRef;
  // The route the mount is when the called function returns no router
  // (`mux.Handle("/x", withAuth(h))`), with its pending data.
  fallback?: Array<{ id: string; properties: GraphNode["properties"] }>;
};

type Router = {
  framework: GoRouteFramework;
  // Its own path below its parent, null when computed at runtime.
  prefix: string | null;
  parent: Router | null;
  // Set on a root: the parameter it is, or RETURNED_ROUTER once returned.
  base: number | null;
  // Middleware it applies itself (`Use`), in order.
  own: GoHandlerRef[];
  // Whether `Use` reaches what was registered before it (echo's root,
  // gorilla/mux) rather than only what comes after (gin, chi, fiber, an echo
  // group).
  global: boolean;
  // How many of its parent's middleware it got (when it was made or mounted).
  parentCount: number;
  // What a function of the file returned (`r := newRouter()`): mounting it
  // mounts that function's routes.
  fromCall?: SyntaxNode;
};

type RouteDraft = {
  node: GraphNode;
  router: Router;
  count: number;
  path: string;
  middleware: GoHandlerRef[];
  handler: GoHandlerRef | null;
  // Kept on the mount it stands for instead of the graph.
  deferred?: true;
};

type PendingArgument = { call: GraphNode; index: number; router: Router; count: number; prefix?: string; callback?: GoHandlerRef; fallback?: RouteDraft[] };

export const routerPackages: Array<[GoRouteFramework, RegExp]> = [
  ["gin", /^github\.com\/gin-gonic\/gin$/u],
  ["echo", /^github\.com\/labstack\/echo(?:\/v\d+)?$/u],
  ["chi", /^github\.com\/go-chi\/chi(?:\/v\d+)?$/u],
  ["fiber", /^github\.com\/gofiber\/fiber(?:\/v\d+)?$/u],
  ["gorilla/mux", /^github\.com\/gorilla\/mux$/u],
  ["net/http", /^net\/http$/u],
];

// The types a parameter holding a router has, per framework.
const routerTypes: Record<GoRouteFramework, Record<string, "root" | "group">> = {
  gin: { Engine: "root", RouterGroup: "group", IRouter: "group", IRoutes: "group" },
  echo: { Echo: "root", Group: "group" },
  chi: { Router: "root", Mux: "root", Routes: "root" },
  fiber: { App: "root", Router: "group", Group: "group" },
  "gorilla/mux": { Router: "root" },
  "net/http": { ServeMux: "root" },
};

const constructors: Record<GoRouteFramework, string[]> = {
  gin: ["Default", "New"],
  echo: ["New"],
  chi: ["NewRouter", "NewMux"],
  fiber: ["New"],
  "gorilla/mux": ["NewRouter"],
  "net/http": ["NewServeMux"],
};

const upperMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE"];
const ginMethods = new Map([...upperMethods.filter((m) => m !== "CONNECT" && m !== "TRACE").map((m) => [m, m] as const), ["Any", "ALL"]]);
const echoMethods = new Map([...upperMethods.map((m) => [m, m] as const), ["Any", "ALL"]]);
const titleMethods = new Map(upperMethods.map((m) => [m[0] + m.slice(1).toLowerCase(), m] as const));
const fiberMethods = new Map([...titleMethods, ["All", "ALL"]]);

const handlerLike = new Set(["identifier", "selector_expression", "call_expression", "func_literal"]);

// A router another package's function returns, by the callee as the file
// writes it (`router.New`); found after the parse (foreign-routers.ts).
export type GoForeignRouter = { framework: GoRouteFramework; kind: "root" | "group" };

export const goRoutesPlugin: GoParsePlugin = createGoRoutesPlugin();

export function createGoRoutesPlugin(foreign: ReadonlyMap<string, GoForeignRouter> = new Map()): GoParsePlugin {
  return (file) => routesOf(file, foreign);
}

function routesOf({ fileNodeId, root, nodes, relationships, functions }: Parameters<GoParsePlugin>[0], foreign: ReadonlyMap<string, GoForeignRouter>): void {
  const imports = importedPackages(root);
  const alias = new Map<GoRouteFramework, string>();
  for (const [source, name] of imports) {
    const framework = routerPackages.find(([, pattern]) => pattern.test(source))?.[0];
    if (framework) alias.set(framework, name);
  }
  if (alias.size === 0 && foreign.size === 0) return;
  const http = alias.get("net/http");

  const constants = new Map<string, string>();
  for (const node of nodes) {
    if (node.label === "Variable" && typeof node.properties.stringValue === "string") constants.set(String(node.properties.name), node.properties.stringValue);
  }
  // Functions of the file that return a router: `r := newRouter()` is one.
  const routerConstructors = new Map<string, GoRouteFramework>();
  for (const fn of functions) {
    const framework = fn.syntax.type === "function_declaration" ? routerTypeOf(String(fn.node.properties.returnType ?? ""), alias)?.framework : undefined;
    if (framework) routerConstructors.set(String(fn.node.properties.name), framework);
  }
  const callsById = new Map(nodes.filter((node) => node.label === "Call").map((node) => [node.id, node]));
  const dynamicCalls: Array<{ line: number; expression: string; framework: string }> = [];
  const newRouter = (framework: GoRouteFramework, kind: "root" | "group" = "root", base: number | null = null): Router => ({
    framework,
    prefix: "",
    parent: null,
    base,
    own: [],
    global: framework === "gorilla/mux" || (framework === "echo" && kind === "root"),
    parentCount: 0,
  });
  const defaultMux = newRouter("net/http");

  for (const fn of functions) {
    const body = fn.syntax.childForFieldName("body");
    if (!body) continue;
    const locals = localTypes(fn.syntax);
    const routers = new Map<string, Router>();
    // Locals holding what a call of another function returned
    // (`admin := adminRouter()`), mountable as a router.
    const results = new Map<string, SyntaxNode>();
    // Routers reached through a field (`s.router`), one per expression.
    const fieldRouters = new Map<string, Router>();
    const drafts: RouteDraft[] = [];
    const pendingArguments: PendingArgument[] = [];
    const closures: Array<{ node: GraphNode; syntax: SyntaxNode }> = [];

    goParameters(fn.syntax.childForFieldName("parameters")).forEach((parameter, index) => {
      const type = parameter.type ? routerTypeOf(parameter.type, alias) : null;
      if (parameter.name && type) routers.set(parameter.name, newRouter(type.framework, type.kind, index));
    });

    const stringValue = (node: SyntaxNode | undefined): string | null => {
      if (!node) return null;
      if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") return node.text.slice(1, -1);
      if (node.type === "identifier") return constants.get(node.text) ?? null;
      // `http.MethodGet`.
      if (node.type === "selector_expression" && http && node.childForFieldName("operand")?.text === http) {
        const method = /^Method([A-Z][a-z]+)$/u.exec(node.childForFieldName("field")?.text ?? "")?.[1];
        return method ? method.toUpperCase() : null;
      }
      if (node.type === "parenthesized_expression") return stringValue(node.namedChildren[0]);
      if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
        const left = stringValue(node.childForFieldName("left") ?? undefined);
        const right = stringValue(node.childForFieldName("right") ?? undefined);
        return left === null || right === null ? null : left + right;
      }
      return null;
    };

    const callNodeOf = (call: SyntaxNode): GraphNode | undefined => {
      const expression = analyzeMemberCallExpression(call.childForFieldName("function")?.text)?.expression;
      return callsById.get(`${fn.node.id}:call:${call.startPosition.row + 1}:${call.startPosition.column}:${expression}`);
    };

    const handlerRef = (node: SyntaxNode, scope: GoHandlerRef["scope"], syntheticName: string): GoHandlerRef => {
      if (node.type === "func_literal") {
        const closure = closureFunctionNode(fileNodeId, node, syntheticName);
        closures.push({ node: closure, syntax: node });
        return { expression: syntheticName, callee: syntheticName, receiver: null, functionId: closure.id, scope };
      }
      // `http.HandlerFunc(f)` and `gin.WrapF(f)` name f; any other call
      // (`AuthMiddleware(true)`, `mw(next)`) returns the handler.
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        const args = node.childForFieldName("arguments")?.namedChildren ?? [];
        if (callee && args.length === 1 && isWrapper(callee.text, alias)) return handlerRef(args[0]!, scope, syntheticName);
        return { ...reference(callee?.text ?? node.text, locals), factory: true, call: callText(node), scope };
      }
      return { ...reference(node.text, locals), scope };
    };

    // An `http.Handler` wrapped in middleware (`withAuth(http.HandlerFunc(h))`,
    // `http.StripPrefix("/s/", fs)`): the wrappers, outermost first, then the
    // handler.
    const handlerChain = (node: SyntaxNode, syntheticName: string): GoHandlerRef[] => {
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        const args = node.childForFieldName("arguments")?.namedChildren ?? [];
        if (callee && http && callee.text === `${http}.StripPrefix` && args.length === 2) return handlerChain(args[1]!, syntheticName);
        if (callee && args.length === 1 && isWrapper(callee.text, alias)) return handlerChain(args[0]!, syntheticName);
        if (callee && args.length === 1 && handlerLike.has(args[0]!.type)) {
          return [{ ...reference(callee.text, locals), factory: true, scope: "route" }, ...handlerChain(args[0]!, syntheticName)];
        }
      }
      return [handlerRef(node, "route", syntheticName)];
    };

    const child = (parent: Router, prefix: string | null, own: GoHandlerRef[], global = false): Router => ({
      framework: parent.framework,
      prefix,
      parent,
      base: null,
      own,
      global,
      parentCount: parent.own.length,
    });

    const evaluate = (node: SyntaxNode | null | undefined): Router | null => {
      if (!node) return null;
      if (node.type === "identifier") return routers.get(node.text) ?? null;
      if (node.type === "parenthesized_expression") return evaluate(node.namedChildren[0]);
      if (node.type === "unary_expression" && node.childForFieldName("operator")?.text === "&") {
        const operand = node.childForFieldName("operand");
        return operand?.type === "composite_literal" && http && operand.childForFieldName("type")?.text === `${http}.ServeMux` ? newRouter("net/http") : null;
      }
      if (node.type === "selector_expression") return http && node.text === `${http}.DefaultServeMux` ? defaultMux : null;
      if (node.type !== "call_expression") return null;
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      if (!callee) return null;
      for (const [framework, name] of alias) {
        if (constructors[framework].some((constructor) => callee.text === `${name}.${constructor}`)) return newRouter(framework);
      }
      if (callee.type === "identifier" && routerConstructors.has(callee.text)) return { ...newRouter(routerConstructors.get(callee.text)!), fromCall: node };
      const external = foreign.get(callee.text);
      if (external) return newRouter(external.framework, external.kind);
      if (callee.type !== "selector_expression") return null;
      const method = callee.childForFieldName("field")?.text;
      const operand = callee.childForFieldName("operand");
      // `r.PathPrefix("/api").Subrouter()`.
      if (method === "Subrouter" && operand?.type === "call_expression") {
        const inner = operand.childForFieldName("function");
        const muxRouter = inner?.type === "selector_expression" ? evaluate(inner.childForFieldName("operand")) : null;
        const innerMethod = inner?.childForFieldName("field")?.text;
        if (muxRouter?.framework === "gorilla/mux" && (innerMethod === "PathPrefix" || innerMethod === "Path")) {
          return child(muxRouter, stringValue(operand.childForFieldName("arguments")?.namedChildren[0]), [], true);
        }
        return null;
      }
      const receiver = evaluate(operand);
      if (!receiver) return null;
      if ((receiver.framework === "gin" || receiver.framework === "echo" || receiver.framework === "fiber") && method === "Group" && args.length >= 1) {
        const prefix = stringValue(args[0]);
        const own = args.slice(1).map((arg, index) => handlerRef(arg, "router", `<${callee.text}:${prefix ?? "?"}:arg${index + 1}>`));
        return child(receiver, prefix, own);
      }
      // `r.With(mw).Get(…)`.
      if (receiver.framework === "chi" && method === "With") {
        return child(receiver, "", args.map((arg, index) => handlerRef(arg, "router", `<${callee.text}:arg${index}>`)));
      }
      return null;
    };

    // `s.router.GET(…)`: a router held in a field the parser has no type for,
    // taken as one when the file imports a single framework with that method.
    const receiverRouter = (operand: SyntaxNode, method: string, args: SyntaxNode[]): Router | null => {
      const known = evaluate(operand);
      if (known) return known;
      if (operand.type !== "selector_expression" || /[()[\]]/u.test(operand.text) || args.length < 2) return null;
      const first = stringValue(args[0]);
      if (first === null) return null;
      const candidates = [...alias.keys()].filter((framework) => {
        if (framework === "gin") return ginMethods.has(method);
        if (framework === "echo") return echoMethods.has(method);
        if (framework === "chi") return titleMethods.has(method);
        if (framework === "fiber") return fiberMethods.has(method);
        if (framework === "gorilla/mux") return method === "HandleFunc" || method === "Handle";
        return (method === "HandleFunc" || method === "Handle") && /^(?:[A-Z]+\s+)?\S*\//u.test(first);
      });
      // gorilla/mux takes HandleFunc over net/http in a file that imports both.
      const framework = candidates.length === 2 && candidates.includes("gorilla/mux") && candidates.includes("net/http") ? "gorilla/mux" : candidates.length === 1 ? candidates[0]! : null;
      if (!framework) return null;
      let router = fieldRouters.get(operand.text);
      if (!router) {
        router = newRouter(framework);
        fieldRouters.set(operand.text, router);
      }
      return router;
    };

    const addRoute = (call: SyntaxNode, router: Router, method: string, routePath: string, refs: GoHandlerRef[], handlerArg: SyntaxNode | undefined, receiverName: string | null, suffix = "") => {
      const line = call.startPosition.row + 1;
      const handler = refs.pop() ?? null;
      const node: GraphNode = {
        id: `${fileNodeId}:route:${line}:${call.startPosition.column}:${method}:${routePath}${suffix}`,
        label: "Route",
        properties: {
          method,
          path: routePath,
          fullPath: null,
          pathExpression: null,
          receiverName,
          line,
          framework: router.framework,
          handlerName: handler?.functionId ? handler.expression : handlerArg?.text ?? null,
          pendingHandlerRefs: null,
          scopeFunctionId: fn.node.id,
        },
      };
      const draft: RouteDraft = { node, router, count: router.own.length, path: routePath, middleware: refs, handler };
      drafts.push(draft);
      return draft;
    };

    const dynamic = (call: SyntaxNode, framework: GoRouteFramework) => {
      dynamicCalls.push({ line: call.startPosition.row + 1, expression: call.childForFieldName("function")?.text ?? call.text, framework });
    };

    // A router mounted below `parent` at `prefix`: a local one gets `parent`,
    // the result of another function's call is resolved after the parse.
    const mount = (parent: Router, prefix: string, target: SyntaxNode, fallback?: () => RouteDraft[]): boolean => {
      const evaluated = evaluate(target);
      const local = evaluated?.fromCall ? null : evaluated;
      if (local) {
        if (local.parent === null && local.base === null && local !== parent) {
          local.parent = parent;
          local.prefix = prefix;
          local.parentCount = parent.own.length;
        }
        return true;
      }
      const call = evaluated?.fromCall ?? (target.type === "call_expression" ? target : target.type === "identifier" ? results.get(target.text) : undefined);
      const callNode = call ? callNodeOf(call) : undefined;
      if (!callNode) return false;
      const routes = fallback?.() ?? [];
      for (const draft of routes) draft.deferred = true;
      pendingArguments.push({ call: callNode, index: RETURNED_ROUTER, router: parent, count: parent.own.length, prefix, fallback: routes });
      return true;
    };

    // A mount target: a router, or the result of a call or a local that holds
    // one (`api.Routes()`, `admin`), which is followed after the parse;
    // `net/http`'s own handler constructors are not routers.
    const isRouterLike = (node: SyntaxNode): boolean => {
      if (evaluate(node) !== null) return true;
      if (node.type === "identifier") return results.has(node.text);
      if (node.type !== "call_expression") return false;
      const callee = node.childForFieldName("function");
      if (!callee || callee.type === "func_literal") return false;
      return !(http && callee.text.startsWith(`${http}.`));
    };

    // `mux.Handle("/api/", http.StripPrefix("/api", api))` serves api's routes
    // below the stripped prefix; `mux.Handle("/api/", api)` hands it the
    // whole path.
    const mountHandler = (parent: Router, target: SyntaxNode, fallback: () => RouteDraft[]): boolean => {
      if (target.type === "call_expression" && http && target.childForFieldName("function")?.text === `${http}.StripPrefix`) {
        const [prefixArg, inner] = target.childForFieldName("arguments")?.namedChildren ?? [];
        const strip = stringValue(prefixArg);
        return strip !== null && inner !== undefined && isRouterLike(inner) && mount(parent, strip, inner, fallback);
      }
      return isRouterLike(target) && mount(parent, "", target, fallback);
    };

    // `r.Route("/x", func(r chi.Router) {…})`: the callback's parameter is
    // the sub-router; a named callback (`r.Route("/x", adminRoutes)`) gets it
    // after the parse.
    const callback = (call: SyntaxNode, router: Router, target: SyntaxNode | undefined) => {
      if (!target) return;
      if (target.type === "func_literal") {
        const name = goParameters(target.childForFieldName("parameters"))[0]?.name;
        const inner = target.childForFieldName("body");
        if (!name || !inner) return;
        const previous = routers.get(name);
        routers.set(name, router);
        visit(inner);
        if (previous) routers.set(name, previous);
        else routers.delete(name);
        return;
      }
      const callNode = callNodeOf(call);
      if (callNode) pendingArguments.push({ call: callNode, index: 0, router, count: router.own.length, callback: { ...reference(target.text, locals), scope: "router" } });
    };

    const visitCall = (node: SyntaxNode) => {
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      if (!callee) return;

      // `http.HandleFunc(…)`: the default mux.
      const packageLevel = http !== undefined && (callee.text === `${http}.HandleFunc` || callee.text === `${http}.Handle`);
      const method = callee.type === "selector_expression" ? callee.childForFieldName("field")?.text ?? "" : "";
      const operand = callee.type === "selector_expression" ? callee.childForFieldName("operand") : null;
      const receiverName = operand?.text ?? null;
      const router = packageLevel ? defaultMux : operand ? receiverRouter(operand, method, args) : null;
      const name = (routePath: string, index: number) => `<${callee.text}:${routePath}:arg${index}>`;
      const use = (target: Router) => {
        target.own.push(...args.map((arg, index) => handlerRef(arg, "router", `<${callee.text}:arg${index}>`)));
      };

      if (router?.framework === "gin" || router?.framework === "fiber") {
        const methods = router.framework === "gin" ? ginMethods : fiberMethods;
        if (method === "Use") {
          // fiber's `app.Use("/api", mw)` applies below a prefix: not followed.
          if (router.framework === "gin" || stringValue(args[0]) === null) use(router);
          return;
        }
        if (router.framework === "fiber" && method === "Route") {
          callback(node, child(router, stringValue(args[0]), []), args[1]);
          return;
        }
        if (router.framework === "fiber" && method === "Mount" && args[1]) {
          const prefix = stringValue(args[0]);
          if (prefix === null) dynamic(node, "fiber");
          else mount(router, prefix, args[1]);
          return;
        }
        const routeMethod = methods.get(method);
        if (routeMethod || method === (router.framework === "gin" ? "Handle" : "Add")) {
          const methodValue = routeMethod ?? stringValue(args[0]);
          const from = routeMethod ? 1 : 2;
          const routePath = stringValue(args[from - 1]);
          const handlerArgs = args.slice(from);
          if (methodValue === null || routePath === null) dynamic(node, router.framework);
          else if (handlerArgs.length > 0) {
            addRoute(node, router, methodValue.toUpperCase(), routePath, handlerArgs.map((arg, index) => handlerRef(arg, "route", name(routePath, index + from))), handlerArgs[handlerArgs.length - 1], receiverName);
          }
          return;
        }
      }

      if (router?.framework === "echo") {
        if (method === "Use" || method === "Pre") {
          use(router);
          return;
        }
        // `e.GET(path, h, mw…)`: the handler comes first.
        const routeMethod = echoMethods.get(method);
        const shape = routeMethod ? { methods: [routeMethod] as Array<string | null>, from: 1 }
          : method === "Add" ? { methods: [stringValue(args[0])], from: 2 }
            : method === "Match" ? { methods: stringList(args[0], stringValue), from: 2 } : null;
        if (shape) {
          const routePath = stringValue(args[shape.from - 1]);
          const [handlerArg, ...middlewareArgs] = args.slice(shape.from);
          if (routePath === null || shape.methods === null || shape.methods.some((value) => value === null)) dynamic(node, "echo");
          else if (handlerArg) {
            for (const value of shape.methods as string[]) {
              const refs = [...middlewareArgs.map((arg, index) => handlerRef(arg, "route", name(routePath, index + shape.from + 1))), handlerRef(handlerArg, "route", name(routePath, shape.from))];
              addRoute(node, router, value.toUpperCase(), routePath, refs, handlerArg, receiverName, shape.methods.length > 1 ? `:${value}` : "");
            }
          }
          return;
        }
      }

      if (router?.framework === "chi") {
        if (method === "Use") {
          use(router);
          return;
        }
        if (method === "Route" || method === "Group") {
          const prefix = method === "Route" ? stringValue(args[0]) : "";
          callback(node, child(router, prefix, []), args[method === "Route" ? 1 : 0]);
          return;
        }
        if (method === "Mount" && args[1]) {
          const prefix = stringValue(args[0]);
          if (prefix === null) dynamic(node, "chi");
          else {
            const route = () => [addRoute(node, router, "ALL", prefix, handlerChain(args[1]!, name(prefix, 1)), args[1], receiverName)];
            if (!isRouterLike(args[1]) || !mount(router, prefix, args[1], route)) route();
          }
          return;
        }
        const routeMethod = titleMethods.get(method);
        const shape = routeMethod && args.length === 2 ? { method: routeMethod as string | null, from: 1 }
          : (method === "Handle" || method === "HandleFunc") && args.length === 2 ? { method: "ALL" as string | null, from: 1 }
            : (method === "Method" || method === "MethodFunc") && args.length === 3 ? { method: stringValue(args[0]), from: 2 } : null;
        if (shape) {
          const routePath = stringValue(args[shape.from - 1]);
          if (routePath === null || shape.method === null) dynamic(node, "chi");
          else addRoute(node, router, shape.method.toUpperCase(), routePath, handlerChain(args[shape.from]!, name(routePath, shape.from)), args[shape.from], receiverName);
          return;
        }
      }

      if (router?.framework === "gorilla/mux") {
        if (method === "Use") {
          use(router);
          return;
        }
        if ((method === "HandleFunc" || method === "Handle") && args.length === 2) {
          const routePath = stringValue(args[0]);
          if (routePath === null) dynamic(node, "gorilla/mux");
          else {
            const routes = () => addMuxRoutes(node, router, routePath, args[1]!, receiverName, name(routePath, 1));
            if (!(method === "Handle" && mountHandler(router, args[1]!, routes))) routes();
          }
          return;
        }
      }
      // `r.PathPrefix("/static/").Handler(h)`, `r.Path("/x").HandlerFunc(h)`.
      if ((method === "Handler" || method === "HandlerFunc") && operand?.type === "call_expression" && args.length === 1) {
        const inner = operand.childForFieldName("function");
        const innerMethod = inner?.childForFieldName("field")?.text;
        const muxRouter = inner?.type === "selector_expression" ? evaluate(inner.childForFieldName("operand")) : null;
        if (muxRouter?.framework === "gorilla/mux" && (innerMethod === "PathPrefix" || innerMethod === "Path")) {
          const routePath = stringValue(operand.childForFieldName("arguments")?.namedChildren[0]);
          if (routePath === null) dynamic(node, "gorilla/mux");
          else {
            const routes = () => addMuxRoutes(node, muxRouter, routePath, args[0]!, inner!.childForFieldName("operand")!.text, name(routePath, 0));
            if (!(innerMethod === "PathPrefix" && method === "Handler" && mountHandler(muxRouter, args[0]!, routes))) routes();
          }
          return;
        }
      }

      if (router?.framework === "net/http" && (method === "HandleFunc" || method === "Handle" || packageLevel)) {
        const pattern = stringValue(args[0]);
        if (pattern === null) {
          dynamic(node, "net/http");
          return;
        }
        const handlerArg = args[1];
        if (!handlerArg) return;
        const parsed = parseServeMuxPattern(pattern);
        const route = () => [addRoute(node, router, parsed.method, parsed.path, handlerChain(handlerArg, name(parsed.path, 1)), handlerArg, receiverName)];
        if (callee.text.endsWith("HandleFunc") || !mountHandler(router, handlerArg, route)) route();
        return;
      }

      // A router passed to a function: its path and middleware for the
      // routes that function registers.
      const callNode = args.length > 0 ? callNodeOf(node) : undefined;
      if (!callNode) return;
      args.forEach((arg, index) => {
        const value = evaluate(arg);
        if (value) pendingArguments.push({ call: callNode, index, router: value, count: value.own.length });
      });
    };

    // gorilla/mux: `r.HandleFunc(p, h).Methods("GET", "POST")` registers one
    // route per method (ALL without `.Methods`).
    function addMuxRoutes(call: SyntaxNode, router: Router, routePath: string, handlerArg: SyntaxNode, receiverName: string | null, syntheticName: string): RouteDraft[] {
      const methods: string[] = [];
      let current = call;
      while (current.parent?.type === "selector_expression" && current.parent.parent?.type === "call_expression" && current.parent.parent.childForFieldName("function")?.id === current.parent.id) {
        const outer = current.parent.parent;
        if (current.parent.childForFieldName("field")?.text === "Methods") {
          for (const arg of outer.childForFieldName("arguments")?.namedChildren ?? []) {
            const value = stringValue(arg);
            if (value !== null) methods.push(value.toUpperCase());
          }
        }
        current = outer;
      }
      return (methods.length > 0 ? methods : ["ALL"]).map((value) => (
        addRoute(call, router, value, routePath, handlerChain(handlerArg, syntheticName), handlerArg, receiverName, methods.length > 1 ? `:${value}` : "")
      ));
    }

    function visit(scope: SyntaxNode) {
      walkScoped(scope, (node) => {
        if (node.type === "short_var_declaration" || node.type === "assignment_statement") {
          const names = node.childForFieldName("left")?.namedChildren ?? [];
          const values = node.childForFieldName("right")?.namedChildren ?? [];
          names.forEach((name, index) => {
            if (name.type !== "identifier") return;
            const value = names.length === values.length ? values[index] : index === 0 && values.length === 1 ? values[0] : undefined;
            const router = names.length === values.length ? evaluate(value) : null;
            if (router) routers.set(name.text, router);
            else if (node.type === "short_var_declaration") routers.delete(name.text);
            if (!router && value?.type === "call_expression" && index === 0) results.set(name.text, value);
            else results.delete(name.text);
          });
          return;
        }
        if (node.type === "var_spec") {
          const values = node.childForFieldName("value")?.namedChildren ?? [];
          node.childrenForFieldName("name").forEach((name, index) => {
            const router = evaluate(values[index]);
            if (router) routers.set(name.text, router);
          });
          return;
        }
        if (node.type === "call_expression") visitCall(node);
      }, (node) => node.type === "func_literal");
    }
    visit(body);

    // Routers the function returns: their routes' paths come from the
    // callers that mount the result.
    walkScoped(body, (node) => {
      if (node.type !== "return_statement") return;
      for (const value of node.namedChildren[0]?.type === "expression_list" ? node.namedChildren[0].namedChildren : node.namedChildren) {
        const router = evaluate(value);
        const top = router ? topOf(router) : null;
        if (top && top.base === null && top !== defaultMux) top.base = RETURNED_ROUTER;
      }
    }, (node) => node.type === "func_literal");

    for (const draft of drafts) {
      const prefix = prefixOf(draft.router);
      // chi serves a sub-router's "/" at the mount path itself
      // (`r.Route("/articles", …)` + `r.Get("/", …)` is GET /articles).
      if (draft.router.framework === "chi" && draft.path === "/") draft.path = "";
      const base = topOf(draft.router).base;
      const pending: GoPendingRoute = { base, path: null, middleware: [...middlewareOf(draft.router, draft.count), ...draft.middleware], handler: draft.handler };
      if (prefix === null) draft.node.properties.pathExpression = expressionOf(draft.router);
      else {
        // A returned router's routes keep their own path when no caller
        // mounts it (`r := NewRouter(); r.Run()`).
        if (base === null || base === RETURNED_ROUTER) draft.node.properties.fullPath = joinRoutePaths(prefix, draft.path);
        if (base !== null) pending.path = joinRoutePaths(prefix, draft.path, true);
      }
      draft.node.properties.goPending = JSON.stringify(pending);
      if (draft.deferred) continue;
      nodes.push(draft.node);
      relationships.push({ from: fileNodeId, to: draft.node.id, type: "DECLARES_ROUTE", properties: {} });
    }

    const argumentsByCall = new Map<GraphNode, GoRouterArgument[]>();
    for (const pending of pendingArguments) {
      const prefix = prefixOf(pending.router);
      const argument: GoRouterArgument = {
        index: pending.index,
        prefix: prefix === null ? null : pending.prefix === undefined ? prefix : joinRoutePaths(prefix, pending.prefix, true),
        base: topOf(pending.router).base,
        middleware: middlewareOf(pending.router, pending.count),
        ...pending.callback ? { callback: pending.callback } : {},
        ...pending.fallback?.length ? { fallback: pending.fallback.map((draft) => ({ id: draft.node.id, properties: draft.node.properties })) } : {},
      };
      argumentsByCall.set(pending.call, [...argumentsByCall.get(pending.call) ?? [], argument]);
    }
    for (const [call, routerArguments] of argumentsByCall) call.properties.routerArguments = JSON.stringify(routerArguments);

    // A closure handler is a function of its own.
    addClosures(closures, fn.node.id, fileNodeId, nodes, relationships, callsById);
  }

  if (dynamicCalls.length > 0) {
    const file = nodes.find((node) => node.id === fileNodeId);
    if (file) file.properties.dynamicRouteCalls = JSON.stringify(dynamicCalls);
  }
}

// The local name of each imported package, by path.
export function importedPackages(root: SyntaxNode): Map<string, string> {
  const names = new Map<string, string>();
  for (const spec of root.descendantsOfType("import_spec")) {
    const source = spec.childForFieldName("path")?.text.slice(1, -1);
    if (!source) continue;
    const alias = spec.childForFieldName("name")?.text;
    if (alias === "_" || alias === ".") continue;
    names.set(source, alias ?? defaultPackageName(source));
  }
  return names;
}

// The package name an import path gets without an alias: its last element,
// a major-version suffix (`/v5`) skipped.
function defaultPackageName(source: string): string {
  const parts = source.split("/");
  const last = parts[parts.length - 1]!;
  return /^v\d+$/u.test(last) && parts.length > 1 ? parts[parts.length - 2]! : last;
}

export function routerTypeOf(type: string, alias: Map<GoRouteFramework, string>): { framework: GoRouteFramework; kind: "root" | "group" } | null {
  const bare = type.trim().replace(/^\*/u, "");
  for (const [framework, name] of alias) {
    if (!bare.startsWith(`${name}.`)) continue;
    const kind = routerTypes[framework][bare.slice(name.length + 1)];
    if (kind) return { framework, kind };
  }
  return null;
}

function isWrapper(callee: string, alias: Map<GoRouteFramework, string>): boolean {
  const http = alias.get("net/http");
  const gin = alias.get("gin");
  const echo = alias.get("echo");
  return (http !== undefined && callee === `${http}.HandlerFunc`)
    || (gin !== undefined && (callee === `${gin}.WrapF` || callee === `${gin}.WrapH`))
    || (echo !== undefined && callee === `${echo}.WrapHandler`);
}

// `[]string{"GET", "POST"}`.
function stringList(node: SyntaxNode | undefined, value: (node: SyntaxNode) => string | null): Array<string | null> | null {
  if (node?.type !== "composite_literal") return null;
  const body = node.childForFieldName("body");
  return (body?.namedChildren ?? []).map((element) => value(element.type === "literal_element" ? element.namedChildren[0]! : element));
}

export function reference(expression: string, locals: Map<string, LocalType | null>): Omit<GoHandlerRef, "scope"> {
  const parts = analyzeMemberCallExpression(expression) ?? { expression, callee: expression, receiver: null };
  const local = parts.receiver === null ? undefined : locals.get(parts.receiver.split(".")[0]!);
  return {
    expression: parts.expression,
    callee: parts.callee,
    receiver: parts.receiver,
    ...(local === undefined ? {} : local === null ? { receiverIsLocal: true as const } : "type" in local ? { receiverType: local.type } : { receiverConstructor: local.constructor }),
  };
}

// `GET /items/{id}`, `example.com/x`, `/static/`: the method (ALL without
// one) and the path, the host left out.
export function parseServeMuxPattern(pattern: string): { method: string; path: string } {
  const match = /^([A-Z]+)\s+(.*)$/u.exec(pattern.trim());
  const rest = match ? match[2]!.trim() : pattern.trim();
  const slash = rest.indexOf("/");
  return { method: match ? match[1]! : "ALL", path: slash === -1 ? "/" : rest.slice(slash) };
}

function topOf(router: Router): Router {
  let top = router;
  while (top.parent) top = top.parent;
  return top;
}

// A factory call as written, whitespace collapsed (`users.AuthMiddleware(true)`).
function callText(node: SyntaxNode): string {
  const text = node.text.replace(/\s+/gu, " ");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

// The middleware a registration gets from the routers above it: all of a
// global router's, the ones a router had when the next link was made from it
// otherwise.
function middlewareOf(router: Router, count: number): GoHandlerRef[] {
  const own = (router.global ? router.own : router.own.slice(0, count)).map((ref) => ({ ...ref, scope: "router" as const }));
  return router.parent ? [...middlewareOf(router.parent, router.parentCount), ...own] : own;
}

function prefixOf(router: Router): string | null {
  let prefix = "";
  for (let current: Router | null = router; current; current = current.parent) {
    if (current.prefix === null) return null;
    prefix = joinRoutePaths(current.prefix, prefix, true);
  }
  return prefix;
}

function expressionOf(router: Router): string {
  return router.prefix === null || !router.parent ? "<dynamic group path>" : expressionOf(router.parent);
}

// gin's joinPaths: the paths joined and cleaned, a trailing slash of the
// relative path kept.
export function joinRoutePaths(base: string, relative: string, keepEmpty = false): string {
  if (relative === "") return base === "" && !keepEmpty ? "/" : base;
  const joined = path.posix.join(base === "" ? "/" : base, relative);
  return relative.endsWith("/") && !joined.endsWith("/") ? `${joined}/` : joined;
}
