import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { analyzeMemberCallExpression, walkScoped } from "../../languages/tree-sitter-utils.js";
import { goParameters, localTypes, type GoParsePlugin, type LocalType } from "../../languages/go/parser.js";

// Go HTTP routes, found at parse time from the routers a function builds or
// receives: `r := gin.Default()`, `mux := http.NewServeMux()`, a group
// (`v1 := r.Group("/api")`) or a parameter typed as a router
// (`func Register(router *gin.RouterGroup)`). Each registration
// (`router.GET("/feed", h)`, `mux.HandleFunc("GET /x/{id}", h)`) becomes a
// Route with the path known in its function. What crosses a call (a group
// passed to another function) and handler references are finished once every
// file is parsed (route-mounts.ts).

export type GoRouteFramework = "gin" | "net/http";

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
  // the function called.
  factory?: true;
  functionId?: string;
  // "router" for middleware a router or group applies, "route" for the
  // registration's own.
  scope: "router" | "route";
};

// What a Route keeps until route-mounts.ts finishes it: the parameter its
// router came from (its path and middleware are known at the call sites) and
// the handler and middleware references.
export type GoPendingRoute = {
  base: number | null;
  // The path below the base parameter's router (base routes only).
  path: string | null;
  middleware: GoHandlerRef[];
  handler: GoHandlerRef | null;
};

// A router passed to a function, kept on the Call node: the argument's
// index, its path and middleware, and the caller's own parameter it came
// from, if any.
export type GoRouterArgument = {
  index: number;
  prefix: string | null;
  base: number | null;
  middleware: GoHandlerRef[];
};

type Router = {
  framework: GoRouteFramework;
  // Its own path below its parent, null when computed at runtime.
  prefix: string | null;
  parent: Router | null;
  // The function parameter it is (or descends from).
  base: number | null;
  // The middleware a registration on it gets, in order.
  middleware: GoHandlerRef[];
};

type RouteDraft = {
  node: GraphNode;
  router: Router;
  path: string;
  pending: GoPendingRoute;
};

const ginMethods = new Map([
  ["GET", "GET"],
  ["POST", "POST"],
  ["PUT", "PUT"],
  ["DELETE", "DELETE"],
  ["PATCH", "PATCH"],
  ["HEAD", "HEAD"],
  ["OPTIONS", "OPTIONS"],
  ["Any", "ALL"],
]);

const handlerLike = new Set(["identifier", "selector_expression", "call_expression", "func_literal"]);

const ginRouterTypes = new Set(["Engine", "RouterGroup", "IRouter", "IRoutes"]);

export const goRoutesPlugin: GoParsePlugin = ({ fileNodeId, root, nodes, relationships, functions }) => {
  const imports = importedPackages(root);
  const gin = imports.get("github.com/gin-gonic/gin");
  const http = imports.get("net/http");
  if (!gin && !http) return;

  const constants = new Map<string, string>();
  for (const node of nodes) {
    if (node.label === "Variable" && typeof node.properties.stringValue === "string") constants.set(String(node.properties.name), node.properties.stringValue);
  }
  const callsById = new Map(nodes.filter((node) => node.label === "Call").map((node) => [node.id, node]));
  const dynamicCalls: Array<{ line: number; expression: string; framework: string }> = [];
  const defaultMux: Router = { framework: "net/http", prefix: "", parent: null, base: null, middleware: [] };

  for (const fn of functions) {
    const body = fn.syntax.childForFieldName("body");
    if (!body) continue;
    const locals = localTypes(fn.syntax);
    const routers = new Map<string, Router>();
    // Routers reached through a field (`s.router`), one per expression.
    const fieldRouters = new Map<string, Router>();
    const drafts: RouteDraft[] = [];
    const closures: Array<{ node: GraphNode; syntax: SyntaxNode }> = [];

    goParameters(fn.syntax.childForFieldName("parameters")).forEach((parameter, index) => {
      const framework = parameter.type ? routerType(parameter.type, gin, http) : null;
      if (parameter.name && framework) routers.set(parameter.name, { framework, prefix: "", parent: null, base: index, middleware: [] });
    });

    const stringValue = (node: SyntaxNode | undefined): string | null => {
      if (!node) return null;
      if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") return node.text.slice(1, -1);
      if (node.type === "identifier") return constants.get(node.text) ?? null;
      if (node.type === "parenthesized_expression") return stringValue(node.namedChildren[0]);
      if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
        const left = stringValue(node.childForFieldName("left") ?? undefined);
        const right = stringValue(node.childForFieldName("right") ?? undefined);
        return left === null || right === null ? null : left + right;
      }
      return null;
    };

    const handlerRef = (node: SyntaxNode, scope: GoHandlerRef["scope"], syntheticName: string): GoHandlerRef => {
      if (node.type === "func_literal") {
        const line = node.startPosition.row + 1;
        const closure: GraphNode = {
          id: `${fileNodeId}:function:${line}:${syntheticName}`,
          label: "Function",
          properties: {
            name: syntheticName,
            kind: "func_literal",
            methodKind: null,
            line,
            endLine: node.endPosition.row + 1,
            className: null,
            isExported: false,
            isAsync: false,
            isAbstract: false,
            visibility: "unexported",
            parameters: JSON.stringify(goParameters(node.childForFieldName("parameters"))),
            returnType: node.childForFieldName("result")?.text ?? null,
          },
        };
        closures.push({ node: closure, syntax: node });
        return { expression: syntheticName, callee: syntheticName, receiver: null, functionId: closure.id, scope };
      }
      // `http.HandlerFunc(f)` and `gin.WrapF(f)` name f; any other call
      // (`AuthMiddleware(true)`, `mw(next)`) returns the handler.
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        const args = node.childForFieldName("arguments")?.namedChildren ?? [];
        if (callee && args.length === 1 && isWrapper(callee.text, gin, http)) return handlerRef(args[0]!, scope, syntheticName);
        return { ...reference(callee?.text ?? node.text, locals), factory: true, scope };
      }
      return { ...reference(node.text, locals), scope };
    };

    // A net/http handler wrapped in middleware (`withAuth(http.HandlerFunc(h))`,
    // `http.StripPrefix("/s/", fs)`): the wrappers, outermost first, then the
    // handler.
    const handlerChain = (node: SyntaxNode, syntheticName: string): GoHandlerRef[] => {
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        const args = node.childForFieldName("arguments")?.namedChildren ?? [];
        if (callee && http && callee.text === `${http}.StripPrefix` && args.length === 2) return handlerChain(args[1]!, syntheticName);
        if (callee && args.length === 1 && isWrapper(callee.text, gin, http)) return handlerChain(args[0]!, syntheticName);
        if (callee && args.length === 1 && handlerLike.has(args[0]!.type)) {
          return [{ ...reference(callee.text, locals), factory: true, scope: "route" }, ...handlerChain(args[0]!, syntheticName)];
        }
      }
      return [handlerRef(node, "route", syntheticName)];
    };

    const evaluate = (node: SyntaxNode | null | undefined): Router | null => {
      if (!node) return null;
      if (node.type === "identifier") return routers.get(node.text) ?? null;
      if (node.type === "parenthesized_expression") return evaluate(node.namedChildren[0]);
      if (node.type === "unary_expression" && node.childForFieldName("operator")?.text === "&") {
        const operand = node.childForFieldName("operand");
        return operand?.type === "composite_literal" && http && operand.childForFieldName("type")?.text === `${http}.ServeMux`
          ? { framework: "net/http", prefix: "", parent: null, base: null, middleware: [] }
          : null;
      }
      if (node.type === "selector_expression") {
        if (http && node.text === `${http}.DefaultServeMux`) return defaultMux;
        return null;
      }
      if (node.type !== "call_expression") return null;
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      if (!callee) return null;
      if (gin && (callee.text === `${gin}.Default` || callee.text === `${gin}.New`)) return { framework: "gin", prefix: "", parent: null, base: null, middleware: [] };
      if (http && callee.text === `${http}.NewServeMux`) return { framework: "net/http", prefix: "", parent: null, base: null, middleware: [] };
      if (callee.type !== "selector_expression") return null;
      const method = callee.childForFieldName("field")?.text;
      const receiver = evaluate(callee.childForFieldName("operand"));
      if (receiver?.framework === "gin" && method === "Group" && args.length >= 1) {
        const prefix = stringValue(args[0]);
        const middleware = args.slice(1).map((arg, index) => handlerRef(arg, "router", `<${callee.text}:${prefix ?? "?"}:arg${index + 1}>`));
        return { framework: "gin", prefix, parent: receiver, base: receiver.base, middleware: [...receiver.middleware, ...middleware.map((ref) => ({ ...ref, scope: "router" as const }))] };
      }
      return null;
    };

    // `s.router.GET(…)` in a file that imports gin: a router held in a field
    // the parser has no type for.
    const receiverRouter = (operand: SyntaxNode, method: string, args: SyntaxNode[]): Router | null => {
      const known = evaluate(operand);
      if (known) return known;
      if (operand.type !== "selector_expression" || /[()[\]]/u.test(operand.text) || stringValue(args[0]) === null || args.length < 2) return null;
      const framework: GoRouteFramework | null = gin && ginMethods.has(method)
        ? "gin"
        : http && (method === "HandleFunc" || method === "Handle") && /^(?:[A-Z]+\s+)?\S*\//u.test(stringValue(args[0])!) ? "net/http" : null;
      if (!framework) return null;
      let router = fieldRouters.get(operand.text);
      if (!router) {
        router = { framework, prefix: "", parent: null, base: null, middleware: [] };
        fieldRouters.set(operand.text, router);
      }
      return router;
    };

    const addRoute = (call: SyntaxNode, router: Router, method: string, routePath: string, handlerArgs: SyntaxNode[], expression: string) => {
      const line = call.startPosition.row + 1;
      const offset = call.childForFieldName("arguments")!.namedChildren.length - handlerArgs.length;
      const refs = router.framework === "net/http"
        ? handlerChain(handlerArgs[0]!, `<${expression}:${routePath}:arg${offset}>`)
        : handlerArgs.map((arg, index) => handlerRef(arg, "route", `<${expression}:${routePath}:arg${index + offset}>`));
      const handler = refs.pop() ?? null;
      const handlerArg = handlerArgs[handlerArgs.length - 1];
      const node: GraphNode = {
        id: `${fileNodeId}:route:${line}:${call.startPosition.column}:${method}:${routePath}`,
        label: "Route",
        properties: {
          method,
          path: routePath,
          fullPath: null,
          pathExpression: null,
          receiverName: call.childForFieldName("function")?.childForFieldName("operand")?.text ?? null,
          line,
          framework: router.framework,
          handlerName: handler?.functionId ? handler.expression : handlerArg?.text ?? null,
          pendingHandlerRefs: null,
          scopeFunctionId: fn.node.id,
        },
      };
      drafts.push({ node, router, path: routePath, pending: { base: router.base, path: null, middleware: [...router.middleware, ...refs], handler } });
    };

    const dynamic = (call: SyntaxNode, framework: GoRouteFramework) => {
      dynamicCalls.push({ line: call.startPosition.row + 1, expression: call.childForFieldName("function")?.text ?? call.text, framework });
    };

    walkScoped(body, (node) => {
      if (node.type === "short_var_declaration" || node.type === "assignment_statement") {
        const names = node.childForFieldName("left")?.namedChildren ?? [];
        const values = node.childForFieldName("right")?.namedChildren ?? [];
        names.forEach((name, index) => {
          const router = names.length === values.length ? evaluate(values[index]) : null;
          if (name.type !== "identifier") return;
          if (router) routers.set(name.text, router);
          else if (node.type === "short_var_declaration") routers.delete(name.text);
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
      if (node.type !== "call_expression") return;
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      if (!callee) return;

      // `http.HandleFunc(…)`: the default mux.
      const packageLevel = http && (callee.text === `${http}.HandleFunc` || callee.text === `${http}.Handle`);
      const method = callee.type === "selector_expression" ? callee.childForFieldName("field")?.text ?? "" : "";
      const operand = callee.type === "selector_expression" ? callee.childForFieldName("operand") : null;
      const router = packageLevel ? defaultMux : operand ? receiverRouter(operand, method, args) : null;

      if (router?.framework === "gin") {
        if (method === "Use") {
          router.middleware.push(...args.map((arg, index) => handlerRef(arg, "router", `<${callee.text}:arg${index}>`)));
          return;
        }
        const routeMethod = ginMethods.get(method);
        if (routeMethod || method === "Handle") {
          const methodValue = routeMethod ?? stringValue(args[0]);
          const pathArg = routeMethod ? args[0] : args[1];
          const routePath = stringValue(pathArg);
          const handlerArgs = args.slice(routeMethod ? 1 : 2);
          if (methodValue === null || routePath === null) dynamic(node, "gin");
          else if (handlerArgs.length > 0) addRoute(node, router, methodValue.toUpperCase(), routePath, handlerArgs, callee.text);
          return;
        }
      }

      if (router?.framework === "net/http" && (method === "HandleFunc" || method === "Handle" || packageLevel)) {
        const pattern = stringValue(args[0]);
        if (pattern === null) {
          dynamic(node, "net/http");
          return;
        }
        const parsed = parseServeMuxPattern(pattern);
        const handlerArg = args[1];
        if (!handlerArg) return;
        // `mux.Handle("/api/", http.StripPrefix("/api", api))` serves api's
        // routes below the stripped prefix; `mux.Handle("/api/", api)` hands
        // the whole path to api.
        const mounted = mountedMux(handlerArg);
        if (mounted) {
          if (mounted.router.parent === null && mounted.router.base === null && mounted.router !== router) {
            mounted.router.parent = router;
            mounted.router.prefix = mounted.strip;
          }
          return;
        }
        addRoute(node, router, parsed.method, parsed.path, [handlerArg], callee.text);
        return;
      }

      // A router passed to a function: its path and middleware for the
      // routes that function registers.
      const routerArguments: GoRouterArgument[] = [];
      args.forEach((arg, index) => {
        const value = evaluate(arg);
        if (value) routerArguments.push({ index, prefix: prefixOf(value), base: value.base, middleware: value.middleware });
      });
      if (routerArguments.length > 0) {
        const expression = analyzeMemberCallExpression(callee.text)?.expression;
        const call = callsById.get(`${fn.node.id}:call:${node.startPosition.row + 1}:${node.startPosition.column}:${expression}`);
        if (call) call.properties.routerArguments = JSON.stringify(routerArguments);
      }
    }, (node) => node.type === "func_literal");

    function mountedMux(node: SyntaxNode): { router: Router; strip: string } | null {
      const direct = evaluate(node);
      if (direct?.framework === "net/http") return { router: direct, strip: "" };
      if (node.type !== "call_expression" || !http || node.childForFieldName("function")?.text !== `${http}.StripPrefix`) return null;
      const [prefixArg, inner] = node.childForFieldName("arguments")?.namedChildren ?? [];
      const strip = stringValue(prefixArg);
      const router = evaluate(inner);
      return router?.framework === "net/http" && strip !== null ? { router, strip } : null;
    }

    for (const draft of drafts) {
      const prefix = prefixOf(draft.router);
      if (prefix === null) draft.node.properties.pathExpression = expressionOf(draft.router);
      else if (draft.pending.base === null) draft.node.properties.fullPath = joinRoutePaths(prefix, draft.path);
      else draft.pending.path = joinRoutePaths(prefix, draft.path, true);
      draft.node.properties.goPending = JSON.stringify(draft.pending);
      nodes.push(draft.node);
      relationships.push({ from: fileNodeId, to: draft.node.id, type: "DECLARES_ROUTE", properties: {} });
    }

    // A closure handler is a function of its own: the calls in its body move
    // from the enclosing function to it.
    for (const closure of closures) {
      if (nodes.some((node) => node.id === closure.node.id)) continue;
      nodes.push(closure.node);
      relationships.push({ from: fileNodeId, to: closure.node.id, type: "DEFINES_FUNCTION", properties: {} });
      const start = closure.syntax.startPosition;
      const end = closure.syntax.endPosition;
      for (const relationship of relationships) {
        if (relationship.type !== "CALLS" || relationship.from !== fn.node.id) continue;
        const call = callsById.get(relationship.to);
        if (!call) continue;
        const line = Number(call.properties.line) - 1;
        const column = Number(call.properties.columnNumber);
        const inside = (line > start.row || (line === start.row && column >= start.column))
          && (line < end.row || (line === end.row && column < end.column));
        if (inside) relationship.from = closure.node.id;
      }
    }
  }

  if (dynamicCalls.length > 0) {
    const file = nodes.find((node) => node.id === fileNodeId);
    if (file) file.properties.dynamicRouteCalls = JSON.stringify(dynamicCalls);
  }
};

// The local name of each imported package, by path.
function importedPackages(root: SyntaxNode): Map<string, string> {
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

function routerType(type: string, gin: string | undefined, http: string | undefined): GoRouteFramework | null {
  const bare = type.replace(/^\*/u, "");
  if (gin && bare.startsWith(`${gin}.`) && ginRouterTypes.has(bare.slice(gin.length + 1))) return "gin";
  if (http && bare === `${http}.ServeMux`) return "net/http";
  return null;
}

function isWrapper(callee: string, gin: string | undefined, http: string | undefined): boolean {
  return (http !== undefined && callee === `${http}.HandlerFunc`)
    || (gin !== undefined && (callee === `${gin}.WrapF` || callee === `${gin}.WrapH`));
}

function reference(expression: string, locals: Map<string, LocalType | null>): Omit<GoHandlerRef, "scope"> {
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

function prefixOf(router: Router): string | null {
  let prefix = "";
  for (let current: Router | null = router; current; current = current.parent) {
    if (current.prefix === null) return null;
    prefix = joinRoutePaths(current.prefix, prefix, true);
  }
  return prefix;
}

function expressionOf(router: Router): string {
  return router.prefix === null ? "<dynamic group path>" : expressionOf(router.parent!);
}

// gin's joinPaths: the paths joined and cleaned, a trailing slash of the
// relative path kept.
export function joinRoutePaths(base: string, relative: string, keepEmpty = false): string {
  if (relative === "") return base === "" && !keepEmpty ? "/" : base;
  const joined = path.posix.join(base === "" ? "/" : base, relative);
  return relative.endsWith("/") && !joined.endsWith("/") ? `${joined}/` : joined;
}
