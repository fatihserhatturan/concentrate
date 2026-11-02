import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile } from "../../../core/scan/resolution/indexes.js";
import { joinPath, referenceName, routerImports, stringValue, unwrap } from "./react-router.js";

// Angular Router pages, in a file that imports `@angular/router`: the route
// arrays typed `Routes` / `Route[]` (also with `satisfies` / `as`) and those
// passed to `RouterModule.forRoot(…)`, `RouterModule.forChild(…)` or
// `provideRouter(…)` (inline, or an array of the same file). Each route is a
// Page (framework `angular`, router `object`): `path` as written (Angular
// paths have no leading `/`), `fullPath` joined onto the parent route's,
// `kind` `layout` with `children` or `loadChildren`, `index` for an empty
// child path, `not-found` for `**`, `redirect` for a route that only has
// `redirectTo`. `component` is the class it renders; `loadComponent: () =>
// import('./login.component').then((m) => m.LoginComponent)` records the
// module in `componentSource` and the export in `component` (the default
// export without `.then`). The component graph links both with PAGE_RENDERS.
//
// Lazy children: `loadChildren: () => import('./admin/admin.routes').then((m)
// => m.ADMIN_ROUTES)` is kept in `Page.loadChildren` (`source#Export`), each
// route of an array in `Page.routes` (the array's name) and `Page.routerScope`
// (`root` / `child` for arrays given to `forRoot` / `provideRouter` /
// `forChild`). The contributor below mounts the loaded routes under the
// route that loads them.

const routerSource = /^@angular\/router$/u;

type Route = {
  path: string | null;
  component: string | null;
  componentSource: string | null;
  loadChildren: string | null;
  redirect: boolean;
  line: number;
  column: number;
  children: Route[];
};

export function applyAngularRouterSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): void {
  const imported = routerImports(parsed.nodes, parsed.relationships, fileNodeId, routerSource);
  if (imported.size === 0) return;
  const localsOf = (name: string) => new Set([...imported].filter(([, importedName]) => importedName === name).map(([local]) => local));
  const routeTypes = new Set([...localsOf("Routes"), ...[...localsOf("Route")].map((local) => `${local}[]`)]);
  const routerModules = localsOf("RouterModule");
  const provideRouters = localsOf("provideRouter");

  const arrays = new Map<string, SyntaxNode>();
  const roots = new Map<number, { array: SyntaxNode; name: string | null; scope: string | null }>();
  const visit = (node: SyntaxNode) => {
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      const rawValue = node.childForFieldName("value");
      const value = unwrap(rawValue);
      if (name?.type === "identifier" && value?.type === "array") {
        if (!arrays.has(name.text)) arrays.set(name.text, value);
        const annotation = node.childForFieldName("type")?.text.replace(/^:\s*/u, "") ?? "";
        const cast = rawValue && rawValue !== value ? rawValue.text.slice(value.endIndex - rawValue.startIndex).replace(/^\s*(?:satisfies|as)\s*/u, "") : "";
        if (routeTypes.has(annotation.trim()) || routeTypes.has(cast.trim())) roots.set(value.id, { array: value, name: name.text, scope: null });
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(rootNode);
  const findRouterCalls = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const scope = callee?.type === "member_expression" && routerModules.has(callee.childForFieldName("object")?.text ?? "")
        ? { forRoot: "root", forChild: "child" }[callee.childForFieldName("property")?.text ?? ""] ?? null
        : provideRouters.has(callee?.text ?? "") ? "root" : null;
      const argument = scope ? unwrap(node.childForFieldName("arguments")?.namedChildren[0] ?? null) : null;
      const array = argument?.type === "array" ? argument : argument?.type === "identifier" ? arrays.get(argument.text) : undefined;
      if (scope && array) roots.set(array.id, { array, name: argument?.type === "identifier" ? argument.text : null, scope });
    }
    for (const child of node.namedChildren) if (child) findRouterCalls(child);
  };
  findRouterCalls(rootNode);

  const add = (route: Route, parentPath: string, isChild: boolean, root: { name: string | null; scope: string | null }) => {
    const fullPath = route.path === "**" ? joinPath(parentPath, "**") : joinPath(parentPath, route.path);
    const kind = route.children.length > 0 || route.loadChildren ? "layout"
      : route.redirect && !route.component && !route.componentSource ? "redirect"
      : route.path === "**" ? "not-found"
      : isChild && route.path === "" ? "index"
      : "page";
    const page: GraphNode = {
      id: `${fileNodeId}:page:${route.line}:${route.column}`,
      label: "Page",
      properties: {
        path: route.path,
        fullPath,
        framework: "angular",
        router: "object",
        kind,
        slot: null,
        line: route.line,
        component: route.component,
        componentSource: route.componentSource,
        loadChildren: route.loadChildren,
        routes: root.name,
        routerScope: root.scope,
      },
    };
    parsed.nodes.push(page);
    parsed.relationships.push({ from: fileNodeId, to: page.id, type: "DECLARES_PAGE", properties: {} });
    for (const child of route.children) add(child, fullPath, true, root);
  };
  for (const root of roots.values()) for (const route of routes(root.array)) add(route, "/", false, root);
}

// `{ path, component, loadComponent, children, loadChildren, redirectTo }`
// objects; other entries (spreads, variables, calls) are skipped.
function routes(array: SyntaxNode): Route[] {
  return array.namedChildren.flatMap((item) => {
    const object = unwrap(item);
    if (object?.type !== "object") return [];
    const entries = new Map<string, SyntaxNode | null>();
    for (const pair of object.namedChildren) {
      if (pair?.type === "shorthand_property_identifier") entries.set(pair.text, pair);
      if (pair?.type !== "pair") continue;
      const key = pair.childForFieldName("key");
      const name = key?.type === "string" ? key.text.slice(1, -1) : key?.text;
      if (name) entries.set(name, unwrap(pair.childForFieldName("value")));
    }
    const view = entries.get("component") ?? null;
    const lazyView = lazyImport(entries.get("loadComponent") ?? null);
    const lazyChildren = lazyImport(entries.get("loadChildren") ?? null);
    const children = entries.get("children");
    return [{
      path: stringValue(entries.get("path") ?? null),
      component: view?.type === "shorthand_property_identifier" ? view.text : referenceName(view) ?? lazyView?.exportName ?? null,
      componentSource: view ? null : lazyView?.source ?? null,
      loadChildren: lazyChildren ? `${lazyChildren.source}#${lazyChildren.exportName ?? ""}` : null,
      redirect: entries.has("redirectTo"),
      line: object.startPosition.row + 1,
      column: object.startPosition.column,
      children: children?.type === "array" ? routes(children) : [],
    }];
  });
}

// `() => import('./x')` (the default export) or `() =>
// import('./x').then((m) => m.X)` / `.then(({ X }) => X)` (export X), with a
// block body returning it too.
function lazyImport(node: SyntaxNode | null): { source: string; exportName: string | null } | null {
  if (node?.type !== "arrow_function" && node?.type !== "function_expression") return null;
  let body = node.childForFieldName("body");
  if (body?.type === "statement_block") {
    const statements = body.namedChildren.filter((child) => child?.type !== "comment");
    body = statements.length === 1 && statements[0]?.type === "return_statement" ? statements[0].namedChildren[0] ?? null : null;
  }
  body = unwrap(body);
  let exportName: string | null = null;
  if (body?.type === "call_expression" && body.childForFieldName("function")?.type === "member_expression") {
    const callee = body.childForFieldName("function")!;
    if (callee.childForFieldName("property")?.text !== "then") return null;
    const callback = unwrap(body.childForFieldName("arguments")?.namedChildren[0] ?? null);
    const result = callback?.type === "arrow_function" ? unwrap(callback.childForFieldName("body")) : null;
    exportName = result?.type === "member_expression" ? result.childForFieldName("property")?.text ?? null
      : result?.type === "identifier" ? result.text : null;
    if (!exportName) return null;
    body = unwrap(callee.childForFieldName("object"));
  }
  if (body?.type !== "call_expression" || body.childForFieldName("function")?.type !== "import") return null;
  const argument = body.childForFieldName("arguments")?.namedChildren[0];
  return argument?.type === "string" ? { source: argument.text.slice(1, -1), exportName } : null;
}

// Mounts lazy children. A route with `loadChildren` loads the file its
// dynamic import resolves to: the routes of the array exported under that
// name (or of the file's default export), or, for an NgModule class, the
// `forChild` routes of that module's file and of the modules it imports
// (`AdminRoutingModule`). Their full paths are joined onto the loading
// route's, which may itself be mounted. Routes nothing mounts keep the path
// of a root array.
export const angularRouteMountsContributor: ISemanticContributor = {
  contribute(graph) {
    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const importsByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const pagesByFile = new Map<string, GraphNode[]>();
    const classesByFile = new Map<string, Map<string, string>>();
    const fileOfClass = new Map<string, string>();
    const moduleImports = new Map<string, string[]>();
    for (const rel of graph.relationships) {
      const target = nodesById.get(rel.to);
      if (rel.type === "DECLARES_PAGE" && target?.properties.framework === "angular") {
        pagesByFile.set(rel.from, [...pagesByFile.get(rel.from) ?? [], target]);
      }
      if (rel.type === "DEFINES_CLASS" && target) {
        const byName = classesByFile.get(rel.from) ?? new Map<string, string>();
        byName.set(String(target.properties.name), target.id);
        classesByFile.set(rel.from, byName);
        fileOfClass.set(target.id, rel.from);
      }
      if (rel.type === "MODULE_IMPORTS") moduleImports.set(rel.from, [...moduleImports.get(rel.from) ?? [], rel.to]);
    }

    // Loaded page id → the page that loads it.
    const mountOf = new Map<string, GraphNode>();
    for (const [fileId, pages] of pagesByFile) {
      for (const page of pages) {
        const spec = page.properties.loadChildren;
        if (typeof spec !== "string") continue;
        const [source, exportName] = spec.split("#") as [string, string];
        const importNode = (importsByFile.get(fileId) ?? []).find((node) => node.properties.isDynamic === true && node.properties.source === source);
        const targetFileId = importNode ? relationshipIndex.resolvedFileByImportId.get(importNode.id) : undefined;
        if (!targetFileId) continue;
        const name = exportName || String(nodesById.get(targetFileId)?.properties.defaultExport ?? "");
        let loaded = (pagesByFile.get(targetFileId) ?? []).filter((candidate) => name !== "" && candidate.properties.routes === name);
        const moduleClass = classesByFile.get(targetFileId)?.get(name);
        if (loaded.length === 0 && moduleClass) {
          const files = new Set<string>();
          const seen = new Set<string>();
          const walk = (classId: string) => {
            if (seen.has(classId)) return;
            seen.add(classId);
            const file = fileOfClass.get(classId);
            if (file) files.add(file);
            for (const imported of moduleImports.get(classId) ?? []) walk(imported);
          };
          walk(moduleClass);
          loaded = [...files].flatMap((file) => (pagesByFile.get(file) ?? []).filter((candidate) => candidate.properties.routerScope === "child"));
        }
        for (const child of loaded) if (child.id !== page.id && !mountOf.has(child.id)) mountOf.set(child.id, page);
      }
    }

    const finalPath = new Map<string, string>();
    const resolve = (page: GraphNode, depth: number): string => {
      const known = finalPath.get(page.id);
      if (known !== undefined) return known;
      const own = String(page.properties.fullPath);
      const mount = mountOf.get(page.id);
      const full = mount && depth < 32 ? joinPath(resolve(mount, depth + 1), own.replace(/^\//u, "")) : own;
      finalPath.set(page.id, full);
      return full;
    };
    for (const pages of pagesByFile.values()) {
      for (const page of pages) page.properties.fullPath = resolve(page, 0);
    }
  },
};
