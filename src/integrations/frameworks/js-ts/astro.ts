import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import type { PendingRender } from "./react.js";
import { dependentPackages } from "./nuxt.js";
import { patternKeys } from "./svelte.js";
import { callsOwnedElsewhere, pascalCase, scriptBlockFunction, typeMembers, unwrap } from "./vue.js";

// Astro components: every `.astro` file is one Component (framework `astro`,
// kind `astro`) named by its file name in PascalCase. `props` lists the
// members of the frontmatter's `interface Props` / `type Props = { … }`, or
// else the names destructured from `Astro.props`. The frontmatter is a
// Function named `<frontmatter>` (kind `frontmatter`) that owns its
// top-level calls (they run on every render). Tags of the markup that name
// components (`<Card>`, `<Ui.Card>`), also inside `{expressions}`, are
// `pendingRenders` with the props passed, and an island's `client:*`
// directive (`client:load` → `load`); the component-graph contributor links
// them to the components the file imports, of any framework.
//
// Pages and endpoints, in a package that depends on `astro`: each `.astro`
// file under `src/pages/` is a Page (framework `astro`, router `file`, kind
// `page`, or `not-found` / `error` for `404` / `500`) with PAGE_RENDERS to its
// component, and each `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`,
// `HEAD` and `ALL` function a `.ts` / `.js` file there exports is a Route
// (framework `astro`). Paths are the file path without the extension
// (`posts.json.ts` → `/posts.json`), `index` standing for its folder, with
// `[slug]` and `[...path]` kept; files and folders starting with `_` are
// left out.

type ScriptFacts = { props: string[] | null; frontmatterFunctionId: string };

const scriptFacts = new WeakMap<ParsedSourceFile, ScriptFacts>();

export function applyAstroScriptSemantics({ fileNodeId, rootNode, parsed, state, scriptBlocks }: JsTsParsedFile): void {
  if (fileLanguage(fileNodeId, parsed) !== "astro") return;
  const block = scriptBlocks.find((candidate) => candidate.attributes.includes("frontmatter"));
  if (!block) return;
  const statements = rootNode.namedChildren.filter((statement): statement is SyntaxNode => (
    statement !== null && statement.startIndex >= block.start && statement.endIndex <= block.end
  ));
  const frontmatterFunctionId = scriptBlockFunction(
    fileNodeId,
    rootNode,
    parsed,
    block,
    callsOwnedElsewhere(state.functionAstPairs),
    "<frontmatter>",
    "frontmatter",
  );
  scriptFacts.set(parsed, { props: typedProps(statements) ?? destructuredProps(statements), frontmatterFunctionId });
}

// `interface Props { title: string }` or `type Props = { title: string }`.
function typedProps(statements: readonly SyntaxNode[]): string[] | null {
  for (const child of statements) {
    const statement = child.type === "export_statement" ? child.childForFieldName("declaration") : child;
    if (statement?.childForFieldName("name")?.text !== "Props") continue;
    if (statement.type === "interface_declaration") {
      const body = statement.childForFieldName("body");
      return body ? typeMembers(body) : [];
    }
    if (statement.type === "type_alias_declaration") {
      const value = statement.childForFieldName("value");
      return value?.type === "object_type" ? typeMembers(value) : null;
    }
  }
  return null;
}

// `const { title, items = [] } = Astro.props`.
function destructuredProps(statements: readonly SyntaxNode[]): string[] | null {
  for (const statement of statements) {
    if (statement.type !== "lexical_declaration" && statement.type !== "variable_declaration") continue;
    for (const declarator of statement.namedChildren) {
      if (declarator?.type !== "variable_declarator") continue;
      const pattern = declarator.childForFieldName("name");
      if (unwrap(declarator.childForFieldName("value"))?.text === "Astro.props" && pattern?.type === "object_pattern") return patternKeys(pattern);
    }
  }
  return null;
}

const directivePrefixes = ["client:", "server:", "set:", "is:", "transition:", "define:"];

export function applyAstroMarkupSemantics(page: { fileNodeId: string; documentNode: SyntaxNode; parsed: ParsedSourceFile; source: string }): void {
  const { fileNodeId, documentNode, parsed, source } = page;
  if (fileLanguage(fileNodeId, parsed) !== "astro") return;
  const facts = scriptFacts.get(parsed);
  const renders: PendingRender[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "script_element" || node.type === "style_element") return;
    if (node.type === "start_tag" || node.type === "self_closing_tag") {
      const tag = /^<([\w$-]+(?:\.[\w$]+)*)/u.exec(source.slice(node.startIndex, node.endIndex))?.[1] ?? "";
      if (/^[A-Z]/u.test(tag) || tag.includes(".")) {
        const props: string[] = [];
        let client: string | undefined;
        for (const attribute of node.namedChildren) {
          if (attribute?.type !== "attribute") continue;
          const nameNode = attribute.namedChildren.find((child) => child?.type === "attribute_name");
          const name = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : "";
          if (name.startsWith("client:")) client = name.slice(7);
          const shorthand = /^\{\s*([A-Za-z_$][\w$]*)\s*\}$/u.exec(name)?.[1];
          const prop = shorthand ?? (name === "slot" || directivePrefixes.some((prefix) => name.startsWith(prefix)) ? null : name);
          if (prop && /^[\w$-]+$/u.test(prop)) props.push(prop);
        }
        renders.push({ name: tag, props, line: node.startPosition.row + 1, ...(client ? { client } : {}) });
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(documentNode);

  const fileNode = parsed.nodes.find((node) => node.id === fileNodeId);
  const relativePath = String(fileNode?.properties.relativePath ?? fileNodeId.slice(5));
  const name = pascalCase(path.basename(relativePath, ".astro").replace(/[^\w$.-]/gu, "")) || "Component";
  const component: GraphNode = {
    id: `${fileNodeId}:component:1:${name}`,
    label: "Component",
    properties: {
      name,
      framework: "astro",
      kind: "astro",
      line: 1,
      endLine: documentNode.endPosition.row + (documentNode.endPosition.column === 0 ? 0 : 1),
      isExported: true,
      props: facts?.props && facts.props.length > 0 ? facts.props.join(",") : null,
      pendingRenders: renders.length > 0 ? JSON.stringify(renders) : null,
      hooks: null,
    },
  };
  parsed.nodes.push(component);
  parsed.relationships.push({ from: fileNodeId, to: component.id, type: "DECLARES_COMPONENT", properties: {} });
  if (facts) {
    parsed.relationships.push({ from: component.id, to: facts.frontmatterFunctionId, type: "COMPONENT_DEFINED_BY_FUNCTION", properties: {} });
  }
}

const handlerMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ALL"]);
const endpointExtension = /\.[cm]?[jt]s$/u;

export const astroPagesContributor: ISemanticContributor = {
  async contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const functionsByFile = new Map<string, GraphNode[]>();
    const componentByFile = new Map<string, string>();
    for (const rel of graph.relationships) {
      const target = nodesById.get(rel.to);
      if (rel.type === "DEFINES_FUNCTION" && target && target.properties.className == null) {
        functionsByFile.set(rel.from, [...functionsByFile.get(rel.from) ?? [], target]);
      }
      if (rel.type === "DECLARES_COMPONENT" && target?.properties.framework === "astro") componentByFile.set(rel.from, target.id);
    }

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    for (const project of await dependentPackages(graph, nodesById, "astro")) {
      for (const { file, path: filePath } of project.files) {
        if (!filePath.startsWith("src/pages/") || file.properties.isTest === true) continue;
        const route = filePath.slice("src/pages/".length);
        if (route.split("/").some((segment) => segment.startsWith("_"))) continue;
        if (route.endsWith(".astro")) {
          const routePath = astroPath(route.slice(0, -".astro".length));
          const base = path.posix.basename(route, ".astro");
          const kind = base === "404" ? "not-found" : base === "500" ? "error" : "page";
          const page: GraphNode = {
            id: `${file.id}:page`,
            label: "Page",
            properties: { path: routePath, fullPath: routePath, framework: "astro", router: "file", kind, slot: null, line: null, component: null },
          };
          nodes.push(page);
          relationships.push({ from: file.id, to: page.id, type: "DECLARES_PAGE", properties: {} });
          const component = componentByFile.get(file.id);
          if (component) relationships.push({ from: page.id, to: component, type: "PAGE_RENDERS", properties: {} });
        } else if (endpointExtension.test(route)) {
          const routePath = astroPath(route.replace(endpointExtension, ""));
          for (const fn of functionsByFile.get(file.id) ?? []) {
            const method = String(fn.properties.name);
            if (fn.properties.isExported !== true || !handlerMethods.has(method)) continue;
            const line = Number(fn.properties.line);
            const node: GraphNode = {
              id: `${file.id}:route:${line}:0:${method}:${routePath}`,
              label: "Route",
              properties: { method, path: routePath, fullPath: routePath, pathExpression: null, receiverName: null, line, framework: "astro", handlerName: method },
            };
            nodes.push(node);
            relationships.push({ from: file.id, to: node.id, type: "DECLARES_ROUTE", properties: {} });
            relationships.push({ from: node.id, to: fn.id, type: "ROUTE_HANDLED_BY", properties: {} });
          }
        }
      }
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

// `blog/[slug]` → `/blog/[slug]`, `index` → its folder.
export function astroPath(route: string): string {
  const segments = route.split("/").filter((segment, i, all) => !(segment === "index" && i === all.length - 1));
  return `/${segments.join("/")}`;
}

function fileLanguage(fileNodeId: string, parsed: ParsedSourceFile): unknown {
  return parsed.nodes.find((node) => node.id === fileNodeId)?.properties.language;
}
