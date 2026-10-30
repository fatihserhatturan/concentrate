import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, ImportBinding } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";

// React Router pages, in a file that imports `react-router`,
// `react-router-dom` or `react-router-native`:
// - JSX route trees: every `<Route>` element (under `<Routes>`, `<Switch>` or
//   `createRoutesFromElements`), router `jsx`;
// - route objects: the array passed to `createBrowserRouter`,
//   `createHashRouter`, `createMemoryRouter` or `useRoutes`, inline or as a
//   variable of the same file, router `object`.
// Each route is a Page: `path` is its own segment as written (null for index
// and pathless routes), `fullPath` joins it onto its parent route's (a path
// that starts with `/` stands alone), and `kind` is `layout` when it has
// child routes, `index` for an index route. `component` is the component it renders, `element={<X />}`
// or `Component={X}` (`component={X}` in v5); the component graph links it
// with PAGE_RENDERS. Lazy routes (`lazy: () => import(…)`) and routes
// assembled at runtime are not followed; a `<Routes>` inside a routed
// component starts again from `/`.

const routerSource = /^react-router(?:-dom|-native)?$/u;
const routerFactories = new Set(["createBrowserRouter", "createHashRouter", "createMemoryRouter", "useRoutes"]);

type Route = { path: string | null; index: boolean; component: string | null; line: number; column: number; children: Route[] };

export function applyReactRouterSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): void {
  const imported = routerImports(parsed.nodes, parsed.relationships, fileNodeId);
  if (imported.size === 0) return;
  const routeTag = [...imported].find(([, name]) => name === "Route")?.[0];
  const factories = new Set([...imported].filter(([, name]) => routerFactories.has(name)).map(([local]) => local));

  const roots: Array<{ routes: Route[]; router: "jsx" | "object" }> = [];
  if (routeTag) roots.push({ routes: jsxRoutes(rootNode, routeTag), router: "jsx" });
  if (factories.size > 0) {
    const arrays = new Map<string, SyntaxNode>();
    collectArrayDeclarations(rootNode, arrays);
    const visit = (node: SyntaxNode) => {
      if (node.type === "call_expression" && factories.has(node.childForFieldName("function")?.text ?? "")) {
        const first = unwrap(node.childForFieldName("arguments")?.namedChildren[0] ?? null);
        const array = first?.type === "array" ? first : first?.type === "identifier" ? arrays.get(first.text) : undefined;
        if (array) roots.push({ routes: objectRoutes(array), router: "object" });
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(rootNode);
  }

  const add = (route: Route, parentPath: string, router: "jsx" | "object") => {
    const fullPath = joinPath(parentPath, route.path);
    const page: GraphNode = {
      id: `${fileNodeId}:page:${route.line}:${route.column}`,
      label: "Page",
      properties: {
        path: route.path,
        fullPath,
        framework: "react-router",
        router,
        kind: route.children.length > 0 ? "layout" : route.index ? "index" : "page",
        slot: null,
        line: route.line,
        component: route.component,
      },
    };
    parsed.nodes.push(page);
    parsed.relationships.push({ from: fileNodeId, to: page.id, type: "DECLARES_PAGE", properties: {} });
    for (const child of route.children) add(child, fullPath, router);
  };
  for (const { routes, router } of roots) for (const route of routes) add(route, "/", router);
}

// Local name → exported name of what the file imports from React Router.
function routerImports(nodes: GraphNode[], relationships: JsTsParsedFile["parsed"]["relationships"], fileNodeId: string): Map<string, string> {
  const importIds = new Set(relationships.filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS").map((rel) => rel.to));
  const imported = new Map<string, string>();
  for (const node of nodes) {
    if (node.label !== "Import" || !importIds.has(node.id)) continue;
    if (typeof node.properties.source !== "string" || !routerSource.test(node.properties.source)) continue;
    if (typeof node.properties.bindings !== "string") continue;
    for (const binding of JSON.parse(node.properties.bindings) as ImportBinding[]) {
      if (binding.kind === "named") imported.set(binding.local, binding.imported);
    }
  }
  return imported;
}

// `<Route>` elements nest by JSX: a route's children are the routes among
// its own JSX children, wherever they sit below it.
function jsxRoutes(root: SyntaxNode, routeTag: string): Route[] {
  const visit = (node: SyntaxNode, into: Route[]) => {
    const opening = node.type === "jsx_element" ? node.childForFieldName("open_tag") : node.type === "jsx_self_closing_element" ? node : null;
    if (opening && opening.childForFieldName("name")?.text === routeTag) {
      const attributes = new Map<string, SyntaxNode | null>();
      for (const attribute of opening.namedChildren) {
        if (attribute?.type !== "jsx_attribute") continue;
        const name = attribute.namedChildren[0]?.text;
        if (name) attributes.set(name, attribute.namedChildren[1] ?? null);
      }
      const route: Route = {
        path: stringValue(attributes.get("path") ?? null),
        index: attributes.has("index") && (attributes.get("index") === null || unwrap(attributes.get("index")!)?.type === "true"),
        component: elementComponent(attributes.get("element") ?? null)
          ?? referenceName(attributes.get("Component") ?? null)
          ?? referenceName(attributes.get("component") ?? null),
        line: opening.startPosition.row + 1,
        column: opening.startPosition.column,
        children: [],
      };
      into.push(route);
      if (node.type === "jsx_element") {
        for (const child of node.namedChildren) if (child && child !== opening) visit(child, route.children);
      }
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child, into);
  };
  const routes: Route[] = [];
  visit(root, routes);
  return routes;
}

// `{ path, index, element, Component, children }` objects; other entries
// (spreads, variables) are skipped.
function objectRoutes(array: SyntaxNode): Route[] {
  return array.namedChildren.flatMap((item) => {
    const object = unwrap(item);
    if (object?.type !== "object") return [];
    const entries = new Map<string, SyntaxNode | null>();
    for (const pair of object.namedChildren) {
      if (pair?.type !== "pair") continue;
      const key = pair.childForFieldName("key");
      const name = key?.type === "string" ? key.text.slice(1, -1) : key?.text;
      if (name) entries.set(name, unwrap(pair.childForFieldName("value")));
    }
    const children = entries.get("children");
    return [{
      path: stringValue(entries.get("path") ?? null),
      index: entries.get("index")?.type === "true",
      component: elementComponent(entries.get("element") ?? null) ?? referenceName(entries.get("Component") ?? null),
      line: object.startPosition.row + 1,
      column: object.startPosition.column,
      children: children?.type === "array" ? objectRoutes(children) : [],
    }];
  });
}

// `const routes = [...]` (also `satisfies RouteObject[]` / `as …`) anywhere in the file.
function collectArrayDeclarations(node: SyntaxNode, arrays: Map<string, SyntaxNode>): void {
  if (node.type === "variable_declarator") {
    const name = node.childForFieldName("name");
    const value = unwrap(node.childForFieldName("value"));
    if (name?.type === "identifier" && value?.type === "array" && !arrays.has(name.text)) arrays.set(name.text, value);
  }
  for (const child of node.namedChildren) if (child) collectArrayDeclarations(child, arrays);
}

function unwrap(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current && ["parenthesized_expression", "satisfies_expression", "as_expression", "jsx_expression"].includes(current.type)) {
    current = current.namedChildren[0] ?? null;
  }
  return current;
}

function stringValue(node: SyntaxNode | null): string | null {
  const value = unwrap(node);
  if (value?.type === "string") return value.text.slice(1, -1);
  if (value?.type === "template_string" && !value.namedChildren.some((child) => child?.type === "template_substitution")) return value.text.slice(1, -1);
  return null;
}

// The outermost element of `element={<X />}`, when it is a component.
function elementComponent(node: SyntaxNode | null): string | null {
  const value = unwrap(node);
  const opening = value?.type === "jsx_element" ? value.childForFieldName("open_tag") : value?.type === "jsx_self_closing_element" ? value : null;
  const name = opening?.childForFieldName("name")?.text;
  return name && /^(?:[A-Z]|[A-Za-z_$][\w$]*\.[A-Z])/u.test(name) ? name : null;
}

// `Component={Home}` / `Component={pages.Home}`.
function referenceName(node: SyntaxNode | null): string | null {
  const value = unwrap(node);
  return value?.type === "identifier" || value?.type === "member_expression" ? value.text : null;
}

function joinPath(parent: string, path: string | null): string {
  if (path === null || path === "") return parent;
  const joined = path.startsWith("/") ? path : `${parent}/${path}`;
  const normalized = joined.replace(/\/{2,}/gu, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/u, "") : normalized;
}
