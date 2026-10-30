import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { withSyntaxTree, type SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import { createEntrypointNode } from "./entrypoint-graph.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Next.js App Router pages: in a package that depends on `next`, each
// `page`, `layout`, `template`, `loading`, `error`, `global-error`,
// `not-found` and `default` file under `app/` (or `src/app/` when there is no
// `app/`) is a Page whose path is its folder: route groups `(group)` and
// parallel-route slots `@slot` leave the URL, dynamic segments keep Next's
// syntax (`[id]`, `[...slug]`, `[[...slug]]`). Private folders (`_lib`) and
// intercepting routes (`(.)photo`) are not routable and are skipped.
//
// Pages Router: every file under `pages/` (or `src/pages/`) is a page whose
// path is the file path without its extension (`index` is its folder);
// `_app`, `_document` and `_error` are the custom app, document and error
// page, `404` and `500` the not-found and error pages. `pages/api/` holds API
// routes, not pages; tests are left out.
//
// Each Page has PAGE_RENDERS to the component its file exports as default.

const pageFile = /^(page|layout|template|loading|error|global-error|not-found|default)\.(jsx?|tsx?|mjs|cjs)$/u;
const sourceExtension = /\.(jsx?|tsx?|mjs|cjs)$/u;
const specialPages = new Map([
  ["_app", { kind: "app", path: "/" }],
  ["_document", { kind: "document", path: "/" }],
  ["_error", { kind: "error", path: "/" }],
  ["404", { kind: "not-found", path: "/404" }],
  ["500", { kind: "error", path: "/500" }],
]);

export const nextjsPagesContributor: ISemanticContributor = {
  async contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const componentsByFile = new Map<string, GraphNode[]>();
    for (const rel of graph.relationships) {
      if (rel.type !== "DECLARES_COMPONENT") continue;
      const component = nodesById.get(rel.to);
      if (component) componentsByFile.set(rel.from, [...componentsByFile.get(rel.from) ?? [], component]);
    }

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const addPage = (file: GraphNode, properties: GraphNode["properties"]) => {
      const page: GraphNode = { id: `${file.id}:page`, label: "Page", properties: { ...properties, fullPath: properties.path, line: null, component: null } };
      nodes.push(page);
      relationships.push({ from: file.id, to: page.id, type: "DECLARES_PAGE", properties: {} });
      const component = defaultExportComponent(file, componentsByFile.get(file.id) ?? []);
      if (component) relationships.push({ from: page.id, to: component.id, type: "PAGE_RENDERS", properties: {} });
    };

    for (const project of await nextProjects(graph, nodesById)) {
      for (const { file, segments } of project.pagesFiles) {
        if (segments[0] === "api") continue;
        const special = segments.length === 1 ? specialPages.get(segments[0]!) : undefined;
        if (special) {
          addPage(file, { path: special.path, framework: "nextjs", router: "pages", kind: special.kind, slot: null });
          continue;
        }
        addPage(file, { path: pagesRouterPath(segments), framework: "nextjs", router: "pages", kind: "page", slot: null });
      }

      for (const { file, segments, name } of project.appFiles) {
        const kind = pageFile.exec(name)?.[1];
        if (!kind) continue;
        const slot = [...segments].reverse().find((segment) => segment.startsWith("@"))?.slice(1) ?? null;
        addPage(file, { path: appRouterPath(segments), framework: "nextjs", router: "app", kind, slot });
      }
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

// Route handlers: the `GET`, `POST`, ... functions a `route` file under
// `app/` exports, one Route per method, and the default export of each file
// under `pages/api/`, a Route of method ALL (the handler branches on
// `req.method` itself). Both are handled by the exported function, so env,
// config and data access reach the route like any other.
//
// Middleware: `middleware` (Next 16: `proxy`) at the package root or in
// `src/` is an EntryPoint of kind `middleware` handled by its exported
// `middleware` / `proxy` function or default export; the trigger is its
// `config.matcher` paths, or null when it runs for every request.
const routeFile = /^route\.(jsx?|tsx?|mjs|cjs)$/u;
const handlerMethods = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
const middlewareFile = /^(?:src\/)?(middleware|proxy)\.(jsx?|tsx?|mjs|cjs)$/u;

export const nextjsRoutesContributor: ISemanticContributor = {
  async contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const functionsByFile = new Map<string, GraphNode[]>();
    for (const rel of graph.relationships) {
      if (rel.type !== "DEFINES_FUNCTION") continue;
      const fn = nodesById.get(rel.to);
      if (fn && fn.properties.className == null) functionsByFile.set(rel.from, [...functionsByFile.get(rel.from) ?? [], fn]);
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
          framework: "nextjs",
          handlerName: String(handler.properties.name),
        },
      };
      nodes.push(route);
      relationships.push(
        { from: file.id, to: route.id, type: "DECLARES_ROUTE", properties: {} },
        { from: route.id, to: handler.id, type: "ROUTE_HANDLED_BY", properties: {} },
      );
    };

    for (const project of await nextProjects(graph, nodesById)) {
      for (const { file, segments, name } of project.appFiles) {
        if (!routeFile.test(name)) continue;
        const routePath = appRouterPath(segments);
        for (const fn of functionsByFile.get(file.id) ?? []) {
          const method = String(fn.properties.name);
          if (fn.properties.isExported === true && handlerMethods.has(method)) addRoute(file, method, routePath, fn);
        }
      }

      for (const { file, segments } of project.pagesFiles) {
        if (segments[0] !== "api") continue;
        const defaultExport = file.properties.defaultExport;
        const handler = typeof defaultExport === "string"
          ? (functionsByFile.get(file.id) ?? []).find((fn) => fn.properties.name === defaultExport)
          : undefined;
        if (handler) addRoute(file, "ALL", pagesRouterPath(segments), handler);
      }

      for (const { file, path: filePath } of project.files) {
        const name = middlewareFile.exec(filePath)?.[1];
        if (!name) continue;
        const defaultExport = file.properties.defaultExport;
        const handler = (functionsByFile.get(file.id) ?? []).find((fn) =>
          (fn.properties.name === name && fn.properties.isExported === true) || fn.properties.name === defaultExport);
        if (!handler) continue;
        const matcher = await middlewareMatcher(file);
        const entrypoint = createEntrypointNode({
          fileNodeId: file.id,
          row: Number(handler.properties.line),
          column: 0,
          kind: "middleware",
          trigger: matcher.length > 0 ? matcher.join(", ") : null,
          receiverName: null,
          library: "nextjs",
          handlerName: String(handler.properties.name),
        });
        nodes.push(entrypoint);
        relationships.push(
          { from: file.id, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} },
          { from: entrypoint.id, to: handler.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} },
        );
      }
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

type RouterFile = { file: GraphNode; segments: string[]; name: string };
type NextProject = { files: Array<{ file: GraphNode; path: string }>; appFiles: RouterFile[]; pagesFiles: RouterFile[] };

// The routable files of each package that depends on `next`. App Router
// files keep their folder segments and file name, minus private folders and
// intercepting routes; Pages Router files keep their path without the
// extension, minus tests.
async function nextProjects(graph: IGraphContributor, nodesById: Map<string, GraphNode>): Promise<NextProject[]> {
  const filesByPackage = new Map<string, GraphNode[]>();
  for (const rel of graph.relationships) {
    if (rel.type !== "PACKAGE_CONTAINS_FILE") continue;
    const file = nodesById.get(rel.to);
    if (file?.label === "File") filesByPackage.set(rel.from, [...filesByPackage.get(rel.from) ?? [], file]);
  }

  const projects: NextProject[] = [];
  for (const [packageId, files] of filesByPackage) {
    const packageNode = nodesById.get(packageId);
    const packagePath = packageNode?.properties.path;
    const packageRelativePath = packageNode?.properties.relativePath;
    if (typeof packagePath !== "string" || typeof packageRelativePath !== "string") continue;
    if (!await dependsOnNext(packagePath)) continue;

    const prefix = packageRelativePath === "." || packageRelativePath === "" ? "" : `${packageRelativePath}/`;
    const inPackage = files.flatMap((file) => {
      const relativePath = file.properties.relativePath;
      return typeof relativePath === "string" && relativePath.startsWith(prefix)
        ? [{ file, path: relativePath.slice(prefix.length) }]
        : [];
    });
    const appDirectory = inPackage.some((entry) => entry.path.startsWith("app/")) ? "app/" : "src/app/";
    const pagesDirectory = inPackage.some((entry) => entry.path.startsWith("pages/")) ? "pages/" : "src/pages/";

    const project: NextProject = { files: inPackage, appFiles: [], pagesFiles: [] };
    for (const { file, path: filePath } of inPackage) {
      if (filePath.startsWith(appDirectory)) {
        const segments = filePath.slice(appDirectory.length).split("/");
        const name = segments.pop()!;
        if (!segments.some((segment) => segment.startsWith("_") || segment.startsWith("(."))) project.appFiles.push({ file, segments, name });
      } else if (filePath.startsWith(pagesDirectory) && file.properties.isTest !== true && sourceExtension.test(filePath)) {
        const segments = filePath.slice(pagesDirectory.length).replace(sourceExtension, "").split("/");
        project.pagesFiles.push({ file, segments, name: segments.at(-1)! });
      }
    }
    projects.push(project);
  }
  return projects;
}

// `export const config = { matcher: '/a/:path*' }`, or an array of paths and
// `{ source }` objects: the literal paths, in order.
async function middlewareMatcher(file: GraphNode): Promise<string[]> {
  const filePath = file.properties.path;
  if (typeof filePath !== "string") return [];
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const grammar = /\.tsx?$/u.test(filePath) ? (filePath.endsWith("x") ? "tsx" : "typescript") : "javascript";
  return withSyntaxTree(grammar, source, (tree) => {
    for (const statement of tree.rootNode.namedChildren) {
      const declaration = statement?.type === "export_statement" ? statement.childForFieldName("declaration") : null;
      for (const declarator of declaration?.namedChildren ?? []) {
        if (declarator?.type !== "variable_declarator" || declarator.childForFieldName("name")?.text !== "config") continue;
        const value = declarator.childForFieldName("value");
        const matcher = value?.type === "object"
          ? value.namedChildren.find((pair) => pair?.type === "pair" && propertyKey(pair) === "matcher")?.childForFieldName("value")
          : null;
        return matcher ? matcherPaths(matcher) : [];
      }
    }
    return [];
  });
}

function matcherPaths(node: SyntaxNode): string[] {
  if (node.type === "string") return [node.text.slice(1, -1)];
  if (node.type === "array") return node.namedChildren.flatMap((child) => (child ? matcherPaths(child) : []));
  if (node.type === "object") {
    const source = node.namedChildren.find((pair) => pair?.type === "pair" && propertyKey(pair) === "source")?.childForFieldName("value");
    return source?.type === "string" ? [source.text.slice(1, -1)] : [];
  }
  return [];
}

function propertyKey(pair: SyntaxNode): string | undefined {
  const key = pair.childForFieldName("key");
  return key?.type === "string" ? key.text.slice(1, -1) : key?.text;
}

// Route groups and parallel-route slots leave the URL.
function appRouterPath(segments: readonly string[]): string {
  return `/${segments.filter((segment) => !/^\(.+\)$/u.test(segment) && !segment.startsWith("@")).join("/")}`;
}

// `index` stands for its folder.
function pagesRouterPath(segments: readonly string[]): string {
  return `/${(segments.at(-1) === "index" ? segments.slice(0, -1) : segments).join("/")}`;
}

// The component a file exports as default: `export default function Page()`,
// `export default Page`, or one exported through a wrapper.
function defaultExportComponent(file: GraphNode, components: readonly GraphNode[]): GraphNode | undefined {
  const defaultExport = file.properties.defaultExport;
  if (typeof defaultExport === "string") return components.find((component) => component.properties.name === defaultExport);
  return components.find((component) => typeof component.properties.defaultExportWrapper === "string");
}

async function dependsOnNext(packagePath: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
      const dependencies = manifest[field];
      return typeof dependencies === "object" && dependencies !== null && "next" in dependencies;
    });
  } catch {
    return false;
  }
}
