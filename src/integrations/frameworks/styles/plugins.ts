import type { JsTsFrameworkPlugin } from "../../languages/js-ts/index.js";
import type { HtmlPagePlugin } from "../../languages/html/parser.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import { addStyleReading } from "../../languages/plain/style-graph.js";
import { readStyles, type StyleLanguage } from "../../languages/plain/styles.js";
import {
  addStyleRefs,
  literalClassNames,
  moduleMembers,
  ownerFunction,
  styleImportBindings,
  templateStyleRefs,
  type StyleRef,
  type TemplateDialect,
} from "./class-refs.js";

// Parse-time half of the style links: the class names a file's JSX and
// templates use, and the `<style>` blocks of single-file components. The
// styles contributor (index.ts) links them to the classes.

const JSX_CLASS_ATTRIBUTES = new Map([["className", false], ["class", false], ["classList", true]]);

// JSX `className="btn"`, `className={clsx("a", { b: on })}`, and members of
// style imports (`styles.btn`, `styles["btn"]`) anywhere in the file.
export const stylesJsPlugin: JsTsFrameworkPlugin = {
  name: "styles",
  onFile({ fileNodeId, rootNode, parsed }) {
    const refs: StyleRef[] = [];
    const visit = (node: SyntaxNode) => {
      if (node.type === "jsx_attribute") {
        const name = node.namedChildren[0]?.text ?? "";
        const objects = JSX_CLASS_ATTRIBUTES.get(name);
        const value = node.namedChildren[1];
        if (objects !== undefined && value) {
          const expression = value.type === "jsx_expression" ? value.namedChildren[0] : value;
          const line = node.startPosition.row + 1;
          const owner = ownerFunction(parsed, line);
          for (const className of new Set(literalClassNames(expression, objects))) refs.push({ o: owner, k: "name", n: className, line, a: name });
        }
      }
      for (const child of node.namedChildren) {
        if (child) visit(child);
      }
    };
    visit(rootNode);

    const bindings = styleImportBindings(parsed);
    for (const member of moduleMembers(rootNode, new Set(bindings.keys()))) {
      refs.push({ o: ownerFunction(parsed, member.line), k: "module", n: member.name, line: member.line, a: member.syntax, i: bindings.get(member.local) ?? null });
    }
    addStyleRefs(parsed, fileNodeId, refs);
  },
};

function dialectOf(language: string): TemplateDialect {
  return language === "vue" || language === "svelte" || language === "astro" ? language : "html";
}

const styleLanguages = new Map<string, StyleLanguage | null>([
  ["", "css"], ["css", "css"], ["postcss", "css"], ["pcss", "css"], ["scss", "scss"], ["less", "less"], ["sass", null], ["stylus", null], ["styl", null],
]);

// Class attributes of an HTML page or single-file component, and its
// `<style>` blocks: classes, ids, custom properties and rules of the file.
export const stylesMarkupPlugin: HtmlPagePlugin = {
  name: "styles",
  async onPage({ fileNodeId, documentNode, parsed, source }) {
    const file = parsed.nodes.find((node) => node.id === fileNodeId);
    const language = String(file?.properties.language ?? "html");
    const dialect = dialectOf(language);
    addStyleRefs(parsed, fileNodeId, await templateStyleRefs(documentNode, source, dialect, null));

    const relativePath = String(file?.properties.relativePath ?? fileNodeId.slice("file:".length));
    for (const element of documentNode.namedChildren) {
      if (element?.type !== "style_element") continue;
      const startTag = element.namedChildren.find((child) => child?.type === "start_tag");
      const attributes = new Map<string, string>();
      for (const attribute of startTag?.namedChildren ?? []) {
        if (attribute?.type !== "attribute") continue;
        const text = source.slice(attribute.startIndex, attribute.endIndex);
        const equals = text.indexOf("=");
        const name = (equals === -1 ? text : text.slice(0, equals)).trim().toLowerCase();
        attributes.set(name, equals === -1 ? "" : text.slice(equals + 1).trim().replace(/^(["'])([\s\S]*)\1$/u, "$2"));
      }
      const lang = styleLanguages.get((attributes.get("lang") ?? "").toLowerCase());
      const raw = element.namedChildren.find((child) => child?.type === "raw_text");
      if (!raw || lang === null || lang === undefined) continue;
      const reading = readStyles(source.slice(raw.startIndex, raw.endIndex), lang);
      const scope = attributes.has("module") ? "module"
        : dialect === "vue" ? (attributes.has("scoped") ? "scoped" : null)
        : dialect === "svelte" ? "scoped"
        : dialect === "astro" ? (attributes.has("is:global") ? null : "scoped")
        : null;
      addStyleReading(fileNodeId, relativePath, reading, parsed, raw.startPosition.row, scope);
    }
  },
};

