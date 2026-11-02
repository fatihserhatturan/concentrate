import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { dependentPackages } from "./nuxt.js";

// SvelteKit, in a package that depends on `@sveltejs/kit`. Every file under
// `src/routes/` named `+…` belongs to the route of its folder, whose path is
// the folder path with route groups `(group)` left out and parameters kept
// in SvelteKit's syntax (`[slug]`, `[[lang]]`, `[...rest]`, `[id=integer]`).
//
// Pages: `+page.svelte`, `+layout.svelte` and `+error.svelte` (also with a
// layout reset, `+page@.svelte`) are Pages (framework `sveltekit`, router
// `file`) of kind `page`, `layout` and `error`, each with PAGE_RENDERS to the
// component of its file. The `load` function of `+page.ts` /
// `+page.server.ts` (`+layout.ts` / `+layout.server.ts` for a layout) is
// PAGE_LOADS from that page, `server` telling which.
//
// Routes (framework `sveltekit`): each `GET`, `POST`, `PUT`, `PATCH`,
// `DELETE`, `OPTIONS` and `HEAD` function a `+server.ts` exports, and its
// `fallback` (method ALL); and each form action of `+page.server.ts`
// (`export const actions = { default, login }`), a POST to the page's path
// (`/login`, or `/login?/name` for a named action). A JS/TS plugin marks
// the action functions (`Function.formAction`, the action's name).

const handlerMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const routesFile = /^src\/routes\/(?:(.*)\/)?(\+[^/]+)$/u;

export function applySvelteKitParseSemantics({ fileNodeId, rootNode, parsed, state }: JsTsParsedFile): void {
  if (!/(?:^|\/)\+page\.server\.[cm]?[jt]s$/u.test(fileNodeId)) return;
  const functionIdByAst = new Map(state.functionAstPairs.map((pair) => [pair.astNode.id, pair.functionNodeId]));
  const nodesById = new Map(parsed.nodes.map((node) => [node.id, node]));
  const topLevelFunctions = new Map<string, GraphNode>();
  for (const rel of parsed.relationships) {
    const fn = rel.type === "DEFINES_FUNCTION" && rel.from === fileNodeId ? nodesById.get(rel.to) : undefined;
    if (fn && fn.properties.className == null && !topLevelFunctions.has(String(fn.properties.name))) topLevelFunctions.set(String(fn.properties.name), fn);
  }
  for (const statement of rootNode.namedChildren) {
    if (statement?.type !== "export_statement") continue;
    const declaration = statement.childForFieldName("declaration");
    if (declaration?.type !== "lexical_declaration" && declaration?.type !== "variable_declaration") continue;
    for (const declarator of declaration.namedChildren) {
      if (declarator?.type !== "variable_declarator" || declarator.childForFieldName("name")?.text !== "actions") continue;
      const object = unwrap(declarator.childForFieldName("value"));
      if (object?.type !== "object") continue;
      for (const entry of object.namedChildren) {
        const action = actionFunction(entry, functionIdByAst, topLevelFunctions);
        const fn = action ? nodesById.get(action.functionId) : undefined;
        if (fn) fn.properties.formAction = action!.name;
      }
    }
  }
}

// `default: async (event) => {…}`, `login(event) {…}`, or `login` naming a
// function of the file.
function actionFunction(
  entry: SyntaxNode | null,
  functionIdByAst: ReadonlyMap<number, string>,
  topLevelFunctions: ReadonlyMap<string, GraphNode>,
): { name: string; functionId: string } | null {
  if (entry?.type === "shorthand_property_identifier") {
    const fn = topLevelFunctions.get(entry.text);
    return fn ? { name: entry.text, functionId: fn.id } : null;
  }
  if (entry?.type === "method_definition") {
    const name = entry.childForFieldName("name")?.text;
    const functionId = functionIdByAst.get(entry.id);
    return name && functionId ? { name, functionId } : null;
  }
  if (entry?.type !== "pair") return null;
  const key = entry.childForFieldName("key");
  const name = key?.type === "string" ? key.text.slice(1, -1) : key?.text;
  const value = unwrap(entry.childForFieldName("value"));
  if (!name || !value) return null;
  if (value.type === "identifier") {
    const fn = topLevelFunctions.get(value.text);
    return fn ? { name, functionId: fn.id } : null;
  }
  const functionId = functionIdByAst.get(value.id);
  return functionId ? { name, functionId } : null;
}

function unwrap(node: SyntaxNode | null): SyntaxNode | null {
  while (node && ["parenthesized_expression", "as_expression", "satisfies_expression"].includes(node.type)) node = node.namedChildren[0] ?? null;
  return node;
}

export const svelteKitContributor: ISemanticContributor = {
  async contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const functionsByFile = new Map<string, GraphNode[]>();
    const componentByFile = new Map<string, string>();
    for (const rel of graph.relationships) {
      const target = nodesById.get(rel.to);
      if (rel.type === "DEFINES_FUNCTION" && target && target.properties.className == null) {
        functionsByFile.set(rel.from, [...functionsByFile.get(rel.from) ?? [], target]);
      }
      if (rel.type === "DECLARES_COMPONENT" && target?.properties.framework === "svelte") componentByFile.set(rel.from, target.id);
    }

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const addRoute = (file: GraphNode, method: string, routePath: string, handler: GraphNode) => {
      const line = Number(handler.properties.line);
      const route: GraphNode = {
        id: `${file.id}:route:${line}:0:${method}:${routePath}`,
        label: "Route",
        properties: {
          method,
          path: routePath,
          fullPath: routePath,
          pathExpression: null,
          receiverName: null,
          line,
          framework: "sveltekit",
          handlerName: String(handler.properties.name),
        },
      };
      nodes.push(route);
      relationships.push({ from: file.id, to: route.id, type: "DECLARES_ROUTE", properties: {} });
      relationships.push({ from: route.id, to: handler.id, type: "ROUTE_HANDLED_BY", properties: {} });
    };

    for (const project of await dependentPackages(graph, nodesById, "@sveltejs/kit")) {
      const routeFiles = project.files.flatMap(({ file, path: filePath }) => {
        const match = file.properties.isTest === true ? null : routesFile.exec(filePath);
        return match ? [{ file, dir: match[1] ?? "", name: match[2]! }] : [];
      });

      // `dir|page` / `dir|layout` → the Page of that folder.
      const pages = new Map<string, string>();
      for (const { file, dir, name } of routeFiles) {
        const kind = /^\+(page|layout|error)(?:@[^.]*)?\.svelte$/u.exec(name)?.[1];
        if (!kind) continue;
        const routePath = svelteKitPath(dir);
        const page: GraphNode = {
          id: `${file.id}:page`,
          label: "Page",
          properties: { path: routePath, fullPath: routePath, framework: "sveltekit", router: "file", kind, slot: null, line: null, component: null },
        };
        nodes.push(page);
        relationships.push({ from: file.id, to: page.id, type: "DECLARES_PAGE", properties: {} });
        const component = componentByFile.get(file.id);
        if (component) relationships.push({ from: page.id, to: component, type: "PAGE_RENDERS", properties: {} });
        pages.set(`${dir}|${kind}`, page.id);
      }

      for (const { file, dir, name } of routeFiles) {
        const functions = functionsByFile.get(file.id) ?? [];
        const routePath = svelteKitPath(dir);
        const data = /^\+(page|layout)(\.server)?\.[cm]?[jt]s$/u.exec(name);
        if (data) {
          const pageId = pages.get(`${dir}|${data[1]}`);
          const load = functions.find((fn) => fn.properties.name === "load" && fn.properties.isExported === true);
          if (pageId && load) relationships.push({ from: pageId, to: load.id, type: "PAGE_LOADS", properties: { server: data[2] !== undefined } });
          if (data[1] === "page" && data[2]) {
            for (const fn of functions) {
              const action = fn.properties.formAction;
              if (typeof action === "string") addRoute(file, "POST", action === "default" ? routePath : `${routePath}?/${action}`, fn);
            }
          }
        } else if (/^\+server\.[cm]?[jt]s$/u.test(name)) {
          for (const fn of functions) {
            const fnName = String(fn.properties.name);
            if (fn.properties.isExported !== true) continue;
            if (handlerMethods.has(fnName)) addRoute(file, fnName, routePath, fn);
            else if (fnName === "fallback") addRoute(file, "ALL", routePath, fn);
          }
        }
      }
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

// `blog/[slug]` → `/blog/[slug]`; `(marketing)/about` → `/about`.
export function svelteKitPath(dir: string): string {
  return `/${dir.split("/").filter((segment) => segment !== "" && !/^\(.*\)$/u.test(segment)).join("/")}`;
}
