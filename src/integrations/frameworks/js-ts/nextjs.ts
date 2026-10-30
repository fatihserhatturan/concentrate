import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
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
    const filesByPackage = new Map<string, GraphNode[]>();
    for (const rel of graph.relationships) {
      if (rel.type !== "PACKAGE_CONTAINS_FILE") continue;
      const file = nodesById.get(rel.to);
      if (file?.label === "File") filesByPackage.set(rel.from, [...filesByPackage.get(rel.from) ?? [], file]);
    }

    const componentsByFile = new Map<string, GraphNode[]>();
    for (const rel of graph.relationships) {
      if (rel.type !== "DECLARES_COMPONENT") continue;
      const component = nodesById.get(rel.to);
      if (component) componentsByFile.set(rel.from, [...componentsByFile.get(rel.from) ?? [], component]);
    }

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
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
      const addPage = (file: GraphNode, properties: GraphNode["properties"]) => {
        const page: GraphNode = { id: `${file.id}:page`, label: "Page", properties: { ...properties, fullPath: properties.path } };
        nodes.push(page);
        relationships.push({ from: file.id, to: page.id, type: "DECLARES_PAGE", properties: {} });
        const component = defaultExportComponent(file, componentsByFile.get(file.id) ?? []);
        if (component) relationships.push({ from: page.id, to: component.id, type: "PAGE_RENDERS", properties: {} });
      };

      for (const { file, path: filePath } of inPackage) {
        if (!filePath.startsWith(pagesDirectory) || file.properties.isTest === true || !sourceExtension.test(filePath)) continue;
        const segments = filePath.slice(pagesDirectory.length).replace(sourceExtension, "").split("/");
        if (segments[0] === "api") continue;
        const special = segments.length === 1 ? specialPages.get(segments[0]!) : undefined;
        if (special) {
          addPage(file, { path: special.path, framework: "nextjs", router: "pages", kind: special.kind, slot: null });
          continue;
        }
        if (segments.at(-1) === "index") segments.pop();
        addPage(file, { path: `/${segments.join("/")}`, framework: "nextjs", router: "pages", kind: "page", slot: null });
      }

      for (const { file, path: filePath } of inPackage) {
        if (!filePath.startsWith(appDirectory)) continue;
        const segments = filePath.slice(appDirectory.length).split("/");
        const kind = pageFile.exec(segments.pop()!)?.[1];
        if (!kind || segments.some((segment) => segment.startsWith("_") || segment.startsWith("(."))) continue;

        const slot = [...segments].reverse().find((segment) => segment.startsWith("@"))?.slice(1) ?? null;
        const urlSegments = segments.filter((segment) => !/^\(.+\)$/u.test(segment) && !segment.startsWith("@"));
        addPage(file, { path: `/${urlSegments.join("/")}`, framework: "nextjs", router: "app", kind, slot });
      }
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

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
