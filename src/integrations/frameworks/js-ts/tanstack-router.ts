import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { classifyFile } from "../../../core/scan/file-classification.js";
import { joinPath, referenceName, routerImports, stringValue, unwrap } from "./react-router.js";

// TanStack Router pages, in a file that imports `@tanstack/react-router` or
// `@tanstack/solid-router`:
// - file routes (router `file`): `createFileRoute('/posts/$postId')({…})`
//   and the root route of `__root.*`. `path` is the route id the generator
//   wrote; `fullPath` drops pathless segments (`_auth`) and groups
//   (`(marketing)`), and un-nests `posts_`. `kind` is `layout` for the root
//   and pathless routes, `index` for an id ending in `/`, otherwise `page`;
//   `createLazyFileRoute` (the code-split half of a route) is kind `lazy`.
// - code routes (router `code`): `createRootRoute` / `createRootRouteWithContext`
//   and `createRoute({ getParentRoute: () => parent, path })`, the parent a
//   route variable of the same file. `path: '/'` is an index route, a route
//   with only an `id` a pathless layout, and a route other routes name as
//   parent a `layout`.
// `component` is the `component` option, a component name; an inline
// anonymous function has none. A parent route from another file is not
// followed: the route's path starts from `/`. Generated files are skipped.

const routerSource = /^@tanstack\/(?:react|solid)-router$/u;

type CodeRoute = {
  node: SyntaxNode;
  root: boolean;
  options: Map<string, SyntaxNode | null>;
  parent: string | null;
  fullPath?: string;
};

export function applyTanStackRouterSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): void {
  const imported = routerImports(parsed.nodes, parsed.relationships, fileNodeId, routerSource);
  if (imported.size === 0) return;
  const locals = (name: string) => new Set([...imported].filter(([, exported]) => exported === name).map(([local]) => local));
  const fileRoute = locals("createFileRoute");
  const lazyFileRoute = locals("createLazyFileRoute");
  const rootRoute = new Set([...locals("createRootRoute"), ...locals("createRootRouteWithContext")]);
  const codeRoute = locals("createRoute");
  const relativePath = String(parsed.nodes.find((node) => node.id === fileNodeId)?.properties.relativePath ?? "");
  // The generated route tree (`routeTree.gen.ts`) repeats every route.
  if (classifyFile(relativePath).isGenerated) return;
  const fileName = relativePath.split("/").pop() ?? "";
  const rootIsFileRoute = /^__root\./u.test(fileName);

  const addPage = (node: SyntaxNode, properties: GraphNode["properties"]) => {
    const line = node.startPosition.row + 1;
    const page: GraphNode = {
      id: `${fileNodeId}:page:${line}:${node.startPosition.column}`,
      label: "Page",
      properties: { framework: "tanstack-router", slot: null, line, ...properties },
    };
    parsed.nodes.push(page);
    parsed.relationships.push({ from: fileNodeId, to: page.id, type: "DECLARES_PAGE", properties: {} });
  };

  const codeRoutes: CodeRoute[] = [];
  const codeRoutesByName = new Map<string, CodeRoute>();
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const options = optionsOf(node);
      // createFileRoute('/id')({…}) / createRootRouteWithContext<C>()({…})
      if (callee?.type === "call_expression") {
        const factory = callee.childForFieldName("function")?.text ?? "";
        const id = stringValue(callee.childForFieldName("arguments")?.namedChildren[0] ?? null);
        if ((fileRoute.has(factory) || lazyFileRoute.has(factory)) && id !== null) {
          addPage(node, {
            path: id,
            fullPath: fileRouteUrl(id),
            router: "file",
            kind: lazyFileRoute.has(factory) ? "lazy" : fileRouteKind(id),
            component: componentName(options.get("component") ?? null),
          });
        } else if (rootRoute.has(factory)) {
          codeRoutes.push({ node, root: true, options, parent: null });
        }
      } else if (callee && (rootRoute.has(callee.text) || codeRoute.has(callee.text))) {
        const getParent = unwrap(options.get("getParentRoute") ?? null);
        const body = getParent?.type === "arrow_function" ? unwrap(getParent.childForFieldName("body")) : null;
        codeRoutes.push({ node, root: rootRoute.has(callee.text), options, parent: body?.type === "identifier" ? body.text : null });
      }
      const route = codeRoutes.at(-1);
      const declarator = node.parent?.type === "variable_declarator" ? node.parent.childForFieldName("name") : null;
      if (route?.node === node && declarator?.type === "identifier") codeRoutesByName.set(declarator.text, route);
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(rootNode);

  const parents = new Set(codeRoutes.flatMap((route) => (route.parent ? [codeRoutesByName.get(route.parent)] : [])));
  const fullPathOf = (route: CodeRoute, seen = new Set<CodeRoute>()): string => {
    if (route.fullPath !== undefined) return route.fullPath;
    if (route.root || seen.has(route)) return "/";
    seen.add(route);
    const parent = route.parent ? codeRoutesByName.get(route.parent) : undefined;
    const parentPath = parent ? fullPathOf(parent, seen) : "/";
    const path = stringValue(route.options.get("path") ?? null);
    return route.fullPath = path === "/" ? parentPath : joinPath(parentPath, path);
  };
  for (const route of codeRoutes) {
    const path = stringValue(route.options.get("path") ?? null);
    const pathless = path === null && route.options.has("id");
    addPage(route.node, {
      path: route.root ? "/" : path,
      fullPath: fullPathOf(route),
      router: route.root && rootIsFileRoute ? "file" : "code",
      kind: route.root || pathless || parents.has(route) ? "layout" : path === "/" ? "index" : "page",
      component: componentName(route.options.get("component") ?? null),
    });
  }
}

// The entries of a call's first argument, when it is an object literal.
function optionsOf(call: SyntaxNode): Map<string, SyntaxNode | null> {
  const options = new Map<string, SyntaxNode | null>();
  const object = unwrap(call.childForFieldName("arguments")?.namedChildren[0] ?? null);
  if (object?.type !== "object") return options;
  for (const entry of object.namedChildren) {
    if (entry?.type === "pair") {
      const key = entry.childForFieldName("key");
      const name = key?.type === "string" ? key.text.slice(1, -1) : key?.text;
      if (name) options.set(name, entry.childForFieldName("value"));
    } else if (entry?.type === "shorthand_property_identifier") {
      options.set(entry.text, entry);
    } else if (entry?.type === "method_definition") {
      const name = entry.childForFieldName("name")?.text;
      if (name) options.set(name, entry);
    }
  }
  return options;
}

// `component: Posts`, `component` (shorthand) or `component: function Posts() {…}`.
function componentName(node: SyntaxNode | null): string | null {
  const value = unwrap(node);
  if (value?.type === "shorthand_property_identifier") return value.text;
  if (value?.type === "function_expression") return value.childForFieldName("name")?.text ?? null;
  return referenceName(value);
}

function fileRouteUrl(id: string): string {
  const segments = id.split("/").filter((segment) => segment !== "" && !segment.startsWith("_") && !/^\(.+\)$/u.test(segment));
  return `/${segments.map((segment) => segment.replace(/_$/u, "")).join("/")}`;
}

function fileRouteKind(id: string): string {
  if (id.endsWith("/")) return "index";
  return id.split("/").at(-1)?.startsWith("_") ? "layout" : "page";
}
