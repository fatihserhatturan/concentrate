import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { joinPath, referenceName, routerImports, stringValue, unwrap } from "./react-router.js";

// Vue Router pages, in a file that imports `vue-router`: the route records of
// the `routes` passed to `createRouter` (inline, or an array of the same
// file), and of arrays typed `RouteRecordRaw[]` (`const routes:
// RouteRecordRaw[] = […]`, also with `satisfies` / `as`). Each record is a
// Page (framework `vue-router`, router `object`): `path` as written,
// `fullPath` joined onto the parent record's (a path that starts with `/`
// stands alone), `kind` `layout` with children, `index` for an empty child
// path, `redirect` for a record that only redirects. `component` is the
// component it renders (`component: Home`, or `components: { default: Home
// }`); a lazy one (`component: () => import('./views/About.vue')`) records
// the module in `componentSource`. The component graph links both with
// PAGE_RENDERS. Records built at runtime, spread in or imported from other
// files into the array are not followed.

const routerSource = /^vue-router$/u;

type RouteRecord = {
  path: string | null;
  component: string | null;
  componentSource: string | null;
  redirect: boolean;
  line: number;
  column: number;
  children: RouteRecord[];
};

export function applyVueRouterSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): void {
  const imported = routerImports(parsed.nodes, parsed.relationships, fileNodeId, routerSource);
  if (imported.size === 0) return;
  const factories = new Set([...imported].filter(([, name]) => name === "createRouter").map(([local]) => local));
  const recordTypes = new Set([...imported].filter(([, name]) => name === "RouteRecordRaw").map(([local]) => local));

  const arrays = new Map<string, SyntaxNode>();
  const roots = new Map<number, SyntaxNode>();
  const visit = (node: SyntaxNode) => {
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      const rawValue = node.childForFieldName("value");
      const value = unwrap(rawValue);
      if (name?.type === "identifier" && value?.type === "array") {
        if (!arrays.has(name.text)) arrays.set(name.text, value);
        const annotation = node.childForFieldName("type")?.text ?? "";
        const cast = rawValue && rawValue !== value ? rawValue.text.slice(value.endIndex - rawValue.startIndex) : "";
        if ([...recordTypes].some((type) => isRecordArrayType(annotation, type) || isRecordArrayType(cast, type))) roots.set(value.id, value);
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(rootNode);
  const findFactories = (node: SyntaxNode) => {
    if (node.type === "call_expression" && factories.has(node.childForFieldName("function")?.text ?? "")) {
      const options = unwrap(node.childForFieldName("arguments")?.namedChildren[0] ?? null);
      for (const entry of options?.type === "object" ? options.namedChildren : []) {
        const value = entry?.type === "shorthand_property_identifier" && entry.text === "routes"
          ? entry
          : entry?.type === "pair" && entry.childForFieldName("key")?.text === "routes" ? unwrap(entry.childForFieldName("value")) : null;
        const array = value?.type === "array" ? value : value ? arrays.get(value.text) : undefined;
        if (array) roots.set(array.id, array);
      }
    }
    for (const child of node.namedChildren) if (child) findFactories(child);
  };
  findFactories(rootNode);

  const add = (record: RouteRecord, parentPath: string, isChild: boolean) => {
    const fullPath = joinPath(parentPath, record.path);
    const kind = record.children.length > 0 ? "layout"
      : record.redirect && !record.component && !record.componentSource ? "redirect"
      : isChild && record.path === "" ? "index"
      : "page";
    const page: GraphNode = {
      id: `${fileNodeId}:page:${record.line}:${record.column}`,
      label: "Page",
      properties: {
        path: record.path,
        fullPath,
        framework: "vue-router",
        router: "object",
        kind,
        slot: null,
        line: record.line,
        component: record.component,
        componentSource: record.componentSource,
      },
    };
    parsed.nodes.push(page);
    parsed.relationships.push({ from: fileNodeId, to: page.id, type: "DECLARES_PAGE", properties: {} });
    for (const child of record.children) add(child, fullPath, true);
  };
  for (const array of roots.values()) for (const record of routeRecords(array)) add(record, "/", false);
}

// `RouteRecordRaw[]`, `Array<RouteRecordRaw>` or `readonly RouteRecordRaw[]`,
// after a `:` annotation or `satisfies` / `as`.
function isRecordArrayType(text: string, type: string): boolean {
  const normalized = text.replace(/^\s*(?::|satisfies|as)\s*/u, "").replace(/^readonly\s+/u, "").trim();
  return normalized === `${type}[]` || normalized === `Array<${type}>` || normalized === `ReadonlyArray<${type}>`;
}

// `{ path, component, components, children, redirect }` objects; other
// entries (spreads, variables, calls) are skipped.
function routeRecords(array: SyntaxNode): RouteRecord[] {
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
    let view = entries.get("component") ?? null;
    const named = entries.get("components");
    if (!view && named?.type === "object") {
      for (const pair of named.namedChildren) {
        if (pair?.type === "pair" && pair.childForFieldName("key")?.text === "default") view = unwrap(pair.childForFieldName("value"));
        if (pair?.type === "shorthand_property_identifier" && pair.text === "default") view = pair;
      }
    }
    const children = entries.get("children");
    return [{
      path: stringValue(entries.get("path") ?? null),
      component: view?.type === "shorthand_property_identifier" ? view.text : referenceName(view),
      componentSource: lazySource(view),
      redirect: entries.has("redirect"),
      line: object.startPosition.row + 1,
      column: object.startPosition.column,
      children: children?.type === "array" ? routeRecords(children) : [],
    }];
  });
}

// `() => import('./views/About.vue')`, with a block body returning it too.
function lazySource(view: SyntaxNode | null): string | null {
  if (view?.type !== "arrow_function" && view?.type !== "function_expression") return null;
  let body = view.childForFieldName("body");
  if (body?.type === "statement_block") {
    const statements = body.namedChildren.filter((child) => child?.type !== "comment");
    body = statements.length === 1 && statements[0]?.type === "return_statement" ? statements[0].namedChildren[0] ?? null : null;
  }
  body = unwrap(body);
  if (body?.type !== "call_expression" || body.childForFieldName("function")?.type !== "import") return null;
  const argument = body.childForFieldName("arguments")?.namedChildren[0];
  return argument?.type === "string" ? argument.text.slice(1, -1) : null;
}
