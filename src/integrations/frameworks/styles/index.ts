import path from "node:path";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { styleNodeId } from "../../languages/plain/style-graph.js";
import type { StyleRef } from "./class-refs.js";

// Styles in the graph. The style reader (languages/plain/styles.ts) gives
// every style sheet its `Style` nodes and imports; this contributor links the
// uses it could not resolve alone: `var(--x)` to the custom property
// definitions of the project, and the class names that components and
// templates use (class-refs.ts) to the classes of the style sheets.
//
// - `module` references (`styles.btn` of `import styles from "./x.module.css"`,
//   Vue's `$style.btn`) go through the import to that file's class: exact.
// - `name` references (`className="btn"`, `class="a b"`, `:class`, `class:a`,
//   `[ngClass]`) are matches by name only. A class of a style sheet the file
//   imports, directly or through `@import` / `@use`, or of its own `<style>`
//   block, is `match: "import"`; otherwise the global classes of that name
//   anywhere in the project (`match: "name"`), unless more than
//   MAX_NAME_MATCHES have it. Classes of CSS Modules files and of scoped
//   styles (Vue `scoped`, Svelte, Astro) are never matched by name from
//   another file.

type VarUse = { name: string; line: number };

const MAX_NAME_MATCHES = 20;

export const stylesContributor: ISemanticContributor = {
  contribute(graph) {
    const definitions = new Map<string, Array<{ id: string; file: string }>>();
    const fileOfStyle = new Map<string, string>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "DECLARES_STYLE") fileOfStyle.set(relationship.to, relationship.from);
    }
    for (const node of graph.nodes) {
      if (node.label !== "Style" || node.properties.kind !== "custom-property") continue;
      const name = String(node.properties.name);
      const list = definitions.get(name) ?? [];
      list.push({ id: node.id, file: fileOfStyle.get(node.id) ?? "" });
      definitions.set(name, list);
    }

    for (const file of graph.nodes) {
      if (file.label !== "File" || typeof file.properties.styleVarUses !== "string") continue;
      const uses = JSON.parse(file.properties.styleVarUses) as VarUse[];
      delete file.properties.styleVarUses;
      const linked = new Set<string>();
      for (const use of uses) {
        const candidates = definitions.get(use.name) ?? [];
        // A definition in the same file wins; otherwise every definition of
        // that name in the project (the cascade decides which applies).
        const local = candidates.filter((candidate) => candidate.file === file.id);
        const chosen = local.length > 0 ? local : candidates;
        for (const target of chosen) {
          const key = `${target.id}:${use.line}`;
          if (linked.has(key)) continue;
          linked.add(key);
          graph.addRelationship({
            from: file.id,
            to: target.id,
            type: "USES_STYLE",
            properties: { line: use.line, match: local.length > 0 ? "file" : "name", expression: `var(${use.name})` },
          });
        }
      }
    }

    linkClassRefs(graph);
  },
};

type Graph = Parameters<ISemanticContributor["contribute"]>[0];

function linkClassRefs(graph: Graph): void {
  const nodes = new Map<string, GraphNode>();
  const filesWithRefs: GraphNode[] = [];
  for (const node of graph.nodes) {
    nodes.set(node.id, node);
    if (node.label === "File" && typeof node.properties.styleRefs === "string") filesWithRefs.push(node);
  }
  if (filesWithRefs.length === 0) return;

  const classesByName = new Map<string, Array<{ id: string; file: string; scope: string | null }>>();
  const resolvesTo = new Map<string, string[]>();
  const importsOf = new Map<string, string[]>();
  const componentsOfFile = new Map<string, string[]>();
  const componentOfFunction = new Map<string, string>();
  const classOfMethod = new Map<string, string>();
  const componentOfClass = new Map<string, string>();
  const fileOfNode = new Map<string, string>();
  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const relationship of graph.relationships) {
    switch (relationship.type) {
      case "DECLARES_STYLE":
        fileOfNode.set(relationship.to, relationship.from);
        break;
      case "RESOLVES_TO":
        push(resolvesTo, relationship.from, relationship.to);
        break;
      case "IMPORTS":
        push(importsOf, relationship.from, relationship.to);
        break;
      case "DECLARES_COMPONENT":
        push(componentsOfFile, relationship.from, relationship.to);
        fileOfNode.set(relationship.to, relationship.from);
        break;
      case "COMPONENT_DEFINED_BY_FUNCTION":
        componentOfFunction.set(relationship.to, relationship.from);
        break;
      case "COMPONENT_DEFINED_BY":
        componentOfClass.set(relationship.to, relationship.from);
        break;
      case "DEFINES_METHOD":
        classOfMethod.set(relationship.to, relationship.from);
        break;
      default:
    }
  }
  for (const node of nodes.values()) {
    if (node.label !== "Style" || node.properties.kind !== "class") continue;
    const entry = { id: node.id, file: fileOfNode.get(node.id) ?? "", scope: typeof node.properties.scope === "string" ? node.properties.scope : null };
    push(classesByName, String(node.properties.name), entry);
  }

  // An Angular template file belongs to the component whose `templateUrl` names it.
  const componentsOfTemplate = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.label !== "Component" || typeof node.properties.templateUrl !== "string") continue;
    const owner = nodes.get(fileOfNode.get(node.id) ?? "");
    if (!owner || typeof owner.properties.relativePath !== "string") continue;
    const directory = path.posix.dirname(owner.properties.relativePath.split(path.sep).join("/"));
    push(componentsOfTemplate, `file:${path.posix.normalize(path.posix.join(directory, node.properties.templateUrl))}`, node.id);
  }

  const styleFileIds = new Set<string>();
  for (const node of nodes.values()) {
    if (node.label === "File" && ["css", "scss", "less"].includes(String(node.properties.language))) styleFileIds.add(node.id);
  }
  const reachable = new Map<string, Set<string>>();
  const styleSheetsOf = (fileId: string): Set<string> => {
    const cached = reachable.get(fileId);
    if (cached) return cached;
    const found = new Set<string>();
    const queue = [fileId];
    while (queue.length > 0) {
      for (const importId of importsOf.get(queue.shift()!) ?? []) {
        for (const target of resolvesTo.get(importId) ?? []) {
          if (styleFileIds.has(target) && !found.has(target)) {
            found.add(target);
            queue.push(target);
          }
        }
      }
    }
    reachable.set(fileId, found);
    return found;
  };

  const linked = new Set<string>();
  const link = (from: string, to: string, line: number, match: string, expression: string) => {
    const key = `${from}|${to}|${line}`;
    if (linked.has(key)) return;
    linked.add(key);
    graph.addRelationship({ from, to, type: "USES_STYLE", properties: { line, match, expression } });
  };

  for (const file of filesWithRefs) {
    const refs = JSON.parse(String(file.properties.styleRefs)) as StyleRef[];
    delete file.properties.styleRefs;
    const language = String(file.properties.language);
    const own = componentsOfFile.get(file.id) ?? [];
    const owners = (ref: StyleRef): string[] => {
      if (ref.o) {
        if (nodes.get(ref.o)?.label === "Function") {
          const component = componentOfFunction.get(ref.o) ?? componentOfClass.get(classOfMethod.get(ref.o) ?? "");
          return [component ?? ref.o];
        }
        return [ref.o];
      }
      if (language === "vue" || language === "svelte" || language === "astro") return own.slice(0, 1);
      const template = componentsOfTemplate.get(file.id);
      return template ?? [file.id];
    };
    const sheets = styleSheetsOf(file.id);
    for (const ref of refs) {
      let targets: Array<{ id: string; match: string }> = [];
      if (ref.k === "module") {
        const files = ref.i ? (resolvesTo.get(ref.i) ?? []) : [file.id];
        for (const target of files) {
          const id = styleNodeId(target, "class", ref.n);
          if (nodes.has(id) && (nodes.get(id)!.properties.scope === "module" || ref.i)) targets.push({ id, match: "module" });
        }
      } else {
        const candidates = (classesByName.get(ref.n) ?? []).filter((entry) => entry.scope !== "module" && (entry.scope !== "scoped" || entry.file === file.id));
        const near = candidates.filter((entry) => entry.file === file.id || sheets.has(entry.file));
        if (near.length > 0) targets = near.map((entry) => ({ id: entry.id, match: "import" }));
        else if (candidates.length > 0 && candidates.length <= MAX_NAME_MATCHES) targets = candidates.map((entry) => ({ id: entry.id, match: "name" }));
      }
      if (targets.length === 0) continue;
      for (const from of owners(ref)) {
        for (const target of targets) link(from, target.id, ref.line, target.match, ref.a);
      }
    }
  }
}
