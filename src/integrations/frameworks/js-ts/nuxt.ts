import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphNode, GraphRelationship, ImportBinding } from "../../../core/graph/model.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { resolveDeclaration } from "../../../core/scan/resolution/call-targets.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile } from "../../../core/scan/resolution/indexes.js";
import type { PendingRender } from "./react.js";

// Nuxt, in a package that depends on `nuxt`. The source directory is the
// package root, or `app/` when the package has `app/pages`, `app/layouts`,
// `app/components` or `app/app.vue` (Nuxt 4).
//
// Pages: every `.vue` file under `pages/` is a Page (framework `nuxt`, router
// `file`) whose path is the file path in Vue Router syntax: `index` is its
// folder, `[id]` is `:id`, `[[id]]` `:id?`, `[...slug]` `:slug(.*)*`, and
// route groups `(group)` leave the URL. A page with a folder of the same name
// next to it (`users.vue` and `users/`) is a `layout` of the pages in that
// folder, and their `index.vue` is its `index`. `layouts/*.vue` are Pages of
// kind `layout` without a path, `app.vue` and `error.vue` the app and error
// pages at `/`. Each Page has PAGE_RENDERS to the component of its file.
//
// Auto-imports: a call to a name the file neither declares nor imports at its
// top level resolves to the function exported under that name by a file of
// `composables/` or `utils/` (top level, or `<dir>/index`); a name exported
// twice is left alone. Component tags no import resolves render the
// component of `components/<path>.vue`, named by its path in PascalCase
// (`components/base/Button.vue` → `BaseButton`, without repeating a prefix
// the file name already has: `components/base/BaseButton.vue` →
// `BaseButton`), also with a `Lazy` prefix.
//
// Vue global registrations, in any package: `app.component('UserCard',
// UserCard)` (also on `nuxtApp.vueApp`) in a file that imports `vue` makes
// the component it registers render wherever the package's templates use
// that name and no import resolves it.

const scriptExtension = /\.(ts|js|mjs|mts)$/u;

export const nuxtAutoImportsContributor: ISemanticContributor = {
  async contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const index = createResolutionRelationshipIndex(graph.relationships);
    const resolved = new Set(graph.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO").map((rel) => rel.from));
    const functionsByFile = groupBy(graph.relationships, "DEFINES_FUNCTION", nodesById);
    const variablesByFile = groupBy(graph.relationships, "DEFINES_VARIABLE", nodesById);
    const importNodesByFile = indexImportNodesByFile(graph.nodes, index.fileByImportId);

    const added: GraphRelationship[] = [];
    for (const project of await nuxtProjects(graph, nodesById)) {
      const exported = new Map<string, string[]>();
      for (const { file, path: filePath } of project.files) {
        if (!isAutoImportFile(filePath, project.srcDir)) continue;
        for (const fn of functionsByFile.get(file.id) ?? []) {
          if (fn.properties.isExported !== true || fn.properties.className != null) continue;
          const name = String(fn.properties.name);
          exported.set(name, [...exported.get(name) ?? [], fn.id]);
        }
      }
      if (exported.size === 0) continue;

      const projectFiles = new Set(project.files.map(({ file }) => file.id));
      const topLevelNames = new Map<string, Set<string>>();
      const namesOf = (fileId: string) => {
        let names = topLevelNames.get(fileId);
        if (!names) {
          names = new Set([
            ...(functionsByFile.get(fileId) ?? []).map((fn) => String(fn.properties.name)),
            ...(variablesByFile.get(fileId) ?? []).map((variable) => String(variable.properties.name)),
            ...(importNodesByFile.get(fileId) ?? []).flatMap(importedNames),
          ]);
          topLevelNames.set(fileId, names);
        }
        return names;
      };
      for (const node of graph.nodes) {
        if (node.label !== "Call" || resolved.has(node.id) || node.properties.receiver != null) continue;
        const callee = String(node.properties.callee);
        const targets = exported.get(callee);
        if (targets?.length !== 1) continue;
        const caller = index.callerFunctionByCallId.get(node.id);
        const fileId = caller ? index.fileByFunctionId.get(caller) : index.callerFileByModuleCallId.get(node.id);
        if (!fileId || !projectFiles.has(fileId) || namesOf(fileId).has(callee)) continue;
        added.push({ from: node.id, to: targets[0]!, type: "CALL_RESOLVES_TO", properties: {} });
      }
    }
    for (const rel of added) graph.addRelationship(rel);
  },
};

export const nuxtPagesContributor: ISemanticContributor = {
  async contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const vueComponentByFile = new Map<string, string>();
    for (const rel of graph.relationships) {
      if (rel.type === "DECLARES_COMPONENT" && nodesById.get(rel.to)?.properties.framework === "vue") vueComponentByFile.set(rel.from, rel.to);
    }

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const addPage = (file: GraphNode, kind: string, fullPath: string | null) => {
      const page: GraphNode = {
        id: `${file.id}:page`,
        label: "Page",
        properties: { path: fullPath, fullPath, framework: "nuxt", router: "file", kind, slot: null, line: null, component: null },
      };
      nodes.push(page);
      relationships.push({ from: file.id, to: page.id, type: "DECLARES_PAGE", properties: {} });
      const component = vueComponentByFile.get(file.id);
      if (component) relationships.push({ from: page.id, to: component, type: "PAGE_RENDERS", properties: {} });
    };

    for (const project of await nuxtProjects(graph, nodesById)) {
      const pagesDir = `${project.srcDir}pages/`;
      const pageFiles = project.files.filter(({ file, path: filePath }) => (
        filePath.startsWith(pagesDir) && filePath.endsWith(".vue") && file.properties.isTest !== true
      ));
      const routes = pageFiles.map(({ path: filePath }) => filePath.slice(pagesDir.length, -".vue".length));
      const isLayout = (route: string) => routes.some((other) => other.startsWith(`${route}/`));
      pageFiles.forEach(({ file }, i) => {
        const route = routes[i]!;
        const parent = route.includes("/") ? route.slice(0, route.lastIndexOf("/")) : null;
        const kind = isLayout(route) ? "layout"
          : path.posix.basename(route) === "index" && parent !== null && routes.includes(parent) ? "index"
          : "page";
        addPage(file, kind, nuxtPath(route));
      });

      for (const { file, path: filePath } of project.files) {
        if (!filePath.endsWith(".vue")) continue;
        if (filePath.startsWith(`${project.srcDir}layouts/`)) addPage(file, "layout", null);
        else if (filePath === `${project.srcDir}app.vue`) addPage(file, "app", "/");
        else if (filePath === `${project.srcDir}error.vue`) addPage(file, "error", "/");
      }
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

export const vueGlobalComponentsContributor: ISemanticContributor = {
  async contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const index = createResolutionRelationshipIndex(graph.relationships);
    const importNodesByFile = indexImportNodesByFile(graph.nodes, index.fileByImportId);
    const vueComponents = new Map<string, string>();
    const componentsByFileAndName = new Map<string, Map<string, string[]>>();
    for (const rel of graph.relationships) {
      const component = rel.type === "DECLARES_COMPONENT" ? nodesById.get(rel.to) : undefined;
      if (!component) continue;
      const names = [String(component.properties.name), ...(component.properties.framework === "vue" ? ["default"] : [])];
      let byName = componentsByFileAndName.get(rel.from);
      if (!byName) componentsByFileAndName.set(rel.from, byName = new Map());
      for (const name of names) byName.set(name, [...byName.get(name) ?? [], component.id]);
      if (component.properties.framework === "vue") vueComponents.set(component.id, rel.from);
    }
    if (vueComponents.size === 0) return;

    const packageByFile = new Map<string, string>();
    for (const rel of graph.relationships) {
      if (rel.type === "PACKAGE_CONTAINS_FILE") packageByFile.set(rel.to, rel.from);
    }
    // Package (or "" outside any) → tag name → component; null when two
    // components claim the name.
    const globals = new Map<string, Map<string, string | null>>();
    const register = (packageId: string, name: string, componentId: string) => {
      let byName = globals.get(packageId);
      if (!byName) globals.set(packageId, byName = new Map());
      byName.set(name, byName.has(name) && byName.get(name) !== componentId ? null : componentId);
    };
    const nuxtPackages = new Set<string>();
    for (const project of await nuxtProjects(graph, nodesById)) {
      nuxtPackages.add(project.packageId);
      const componentsDir = `${project.srcDir}components/`;
      for (const { file, path: filePath } of project.files) {
        if (!filePath.startsWith(componentsDir) || !filePath.endsWith(".vue")) continue;
        const componentId = componentsByFileAndName.get(file.id)?.get("default")?.[0];
        if (componentId) register(project.packageId, nuxtComponentName(filePath.slice(componentsDir.length)), componentId);
      }
    }
    for (const node of graph.nodes) {
      const registration = node.label === "Call" ? globalRegistration(node) : null;
      if (!registration) continue;
      const caller = index.callerFunctionByCallId.get(node.id);
      const fileId = caller ? index.fileByFunctionId.get(caller) : index.callerFileByModuleCallId.get(node.id);
      if (!fileId) continue;
      const importsVue = (importNodesByFile.get(fileId) ?? []).some((importNode) => importNode.properties.source === "vue");
      if (!importsVue && !String(node.properties.receiver).endsWith("vueApp")) continue;
      const componentId = resolveDeclaration(registration.binding, fileId, componentsByFileAndName, importNodesByFile, index.resolvedFileByImportId);
      if (componentId && vueComponents.has(componentId)) register(packageByFile.get(fileId) ?? "", registration.name, componentId);
    }
    if (globals.size === 0) return;

    for (const [componentId, fileId] of vueComponents) {
      const component = nodesById.get(componentId)!;
      const renders = parsePendingRenders(component.properties.pendingRenders);
      if (renders.length === 0) continue;
      const packageId = packageByFile.get(fileId) ?? "";
      const byName = globals.get(packageId);
      if (!byName) continue;
      const unresolved: PendingRender[] = [];
      for (const render of renders) {
        const lazy = nuxtPackages.has(packageId) && /^Lazy[A-Z]/u.test(render.name) ? render.name.slice(4) : null;
        const target = byName.get(render.name) ?? (lazy ? byName.get(lazy) : null);
        if (target) graph.addRelationship({ from: componentId, to: target, type: "RENDERS", properties: { props: render.props.join(","), line: render.line } });
        else unresolved.push(render);
      }
      component.properties.pendingRenders = unresolved.length > 0 ? JSON.stringify(unresolved) : null;
    }
  },
};

type NuxtProject = { packageId: string; srcDir: string; files: Array<{ file: GraphNode; path: string }> };

// The files of each package that depends on `nuxt`, with their paths
// relative to the package.
async function nuxtProjects(graph: IGraphContributor, nodesById: Map<string, GraphNode>): Promise<NuxtProject[]> {
  const filesByPackage = new Map<string, GraphNode[]>();
  for (const rel of graph.relationships) {
    if (rel.type !== "PACKAGE_CONTAINS_FILE") continue;
    const file = nodesById.get(rel.to);
    if (file?.label === "File") filesByPackage.set(rel.from, [...filesByPackage.get(rel.from) ?? [], file]);
  }
  const projects: NuxtProject[] = [];
  for (const [packageId, files] of filesByPackage) {
    const packageNode = nodesById.get(packageId);
    const packagePath = packageNode?.properties.path;
    const packageRelativePath = packageNode?.properties.relativePath;
    if (typeof packagePath !== "string" || typeof packageRelativePath !== "string") continue;
    if (!await dependsOnNuxt(packagePath)) continue;
    const prefix = packageRelativePath === "." || packageRelativePath === "" ? "" : `${packageRelativePath}/`;
    const inPackage = files.flatMap((file) => {
      const relativePath = file.properties.relativePath;
      return typeof relativePath === "string" && relativePath.startsWith(prefix) ? [{ file, path: relativePath.slice(prefix.length) }] : [];
    });
    const srcDir = inPackage.some(({ path: filePath }) => /^app\/(?:pages|layouts|components)\/|^app\/app\.vue$/u.test(filePath)) ? "app/" : "";
    projects.push({ packageId, srcDir, files: inPackage });
  }
  return projects;
}

async function dependsOnNuxt(packagePath: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
      const dependencies = manifest[field];
      return typeof dependencies === "object" && dependencies !== null && "nuxt" in dependencies;
    });
  } catch {
    return false;
  }
}

// `composables/useCart.ts`, `utils/format.ts`, `composables/cart/index.ts`.
function isAutoImportFile(filePath: string, srcDir: string): boolean {
  for (const dir of ["composables/", "utils/"]) {
    if (!filePath.startsWith(`${srcDir}${dir}`)) continue;
    const rest = filePath.slice(srcDir.length + dir.length);
    if (!scriptExtension.test(rest)) return false;
    const parts = rest.split("/");
    return parts.length === 1 || (parts.length === 2 && /^index\./u.test(parts[1]!));
  }
  return false;
}

// `users/[id]` → `/users/:id`, `index` → its folder, `(group)` left out.
export function nuxtPath(route: string): string {
  const segments = route.split("/").filter((segment, i, all) => !/^\(.*\)$/u.test(segment) && !(segment === "index" && i === all.length - 1));
  const converted = segments.map((segment) => segment
    .replace(/\[\[([\w-]+)\]\]/gu, ":$1?")
    .replace(/\[\.\.\.([\w-]+)\]/gu, ":$1(.*)*")
    .replace(/\[([\w-]+)\]/gu, ":$1"));
  return `/${converted.join("/")}`;
}

// `base/Button.vue` → `BaseButton`, `base/BaseButton.vue` → `BaseButton`,
// `forms/index.vue` → `Forms`; `.client` / `.server` suffixes are dropped.
export function nuxtComponentName(relativePath: string): string {
  const parts = relativePath.replace(/\.vue$/u, "").replace(/\.(client|server)$/u, "").split("/");
  const file = pascalCase(parts.pop()!);
  const prefix = parts.map(pascalCase).join("");
  if (file === "Index") return prefix || file;
  return prefix && !file.startsWith(prefix) ? `${prefix}${file}` : file;
}

function pascalCase(value: string): string {
  return value.split(/[-_.\s]+/u).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
}

// `app.component('UserCard', UserCard)`: a literal tag name and a binding.
function globalRegistration(call: GraphNode): { name: string; binding: string } | null {
  if (call.properties.callee !== "component" || call.properties.receiver == null) return null;
  let args: unknown;
  try {
    args = JSON.parse(String(call.properties.args));
  } catch {
    return null;
  }
  if (!Array.isArray(args) || args.length !== 2) return null;
  const [name, binding] = args.map(String);
  if (!/^[A-Za-z][\w-]*$/u.test(name!) || !/^[A-Za-z_$][\w$]*$/u.test(binding!)) return null;
  return { name: pascalCase(name!), binding: binding! };
}

function importedNames(importNode: GraphNode): string[] {
  if (typeof importNode.properties.bindings !== "string") return [];
  try {
    return (JSON.parse(importNode.properties.bindings) as ImportBinding[]).map((binding) => binding.local);
  } catch {
    return [];
  }
}

function groupBy(relationships: readonly GraphRelationship[], type: GraphRelationship["type"], nodesById: Map<string, GraphNode>): Map<string, GraphNode[]> {
  const grouped = new Map<string, GraphNode[]>();
  for (const rel of relationships) {
    const node = rel.type === type ? nodesById.get(rel.to) : undefined;
    if (node) grouped.set(rel.from, [...grouped.get(rel.from) ?? [], node]);
  }
  return grouped;
}

function parsePendingRenders(value: GraphNode["properties"][string]): PendingRender[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as PendingRender[] : [];
  } catch {
    return [];
  }
}
