import path from "node:path";
import { readFile } from "node:fs/promises";
import { withSyntaxTree, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { ILanguageParser } from "../../../core/contracts/language-parser.js";
import { parseJsTsSource, type JsTsFrameworkPlugin } from "../js-ts/parser.js";

// HTML pages: `<script src>` becomes an Import of the page, and inline scripts
// are parsed as JavaScript of the page itself. The scripts are parsed from the
// page text with everything else blanked out, so their positions point into
// the .html file.

// `type` values a browser runs as JavaScript; anything else (JSON, templates,
// import maps) is data.
const scriptTypes = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);

type ScriptElement = {
  src: { value: string; line: number; text: string } | null;
  body: { start: number; end: number } | null;
  // Start of `</script>`, where an inline script ends.
  end: number | null;
};

export function createHtmlParser(plugins: readonly JsTsFrameworkPlugin[] = []): ILanguageParser {
  return {
    language: "html",
    parse: (rootPath, filePath) => parseHtmlFile(rootPath, filePath, plugins),
  };
}

export async function parseHtmlFile(
  rootPath: string,
  filePath: string,
  plugins: readonly JsTsFrameworkPlugin[] = [],
): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const scripts = await withSyntaxTree("html", source, (tree) => scriptElements(tree.rootNode));

  const inline = scripts.filter((script) => !script.src && script.body);
  const parsed: ParsedSourceFile = inline.length > 0
    ? await parseJsTsSource(rootPath, filePath, scriptText(source, inline), "javascript", plugins, "html")
    : {
      fileNodeId,
      nodes: [{ id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language: "html" } }],
      relationships: [],
    };

  for (const script of scripts) {
    if (!script.src) continue;
    const importNode = createScriptImportNode(fileNodeId, script.src);
    if (parsed.nodes.some((node) => node.id === importNode.id)) continue;
    parsed.nodes.push(importNode);
    parsed.relationships.push({ from: fileNodeId, to: importNode.id, type: "IMPORTS", properties: {} } satisfies GraphRelationship);
  }
  return parsed;
}

function scriptElements(root: SyntaxNode): ScriptElement[] {
  const scripts: ScriptElement[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "script_element") {
      const script = readScriptElement(node);
      if (script) scripts.push(script);
      return;
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return scripts;
}

function readScriptElement(node: SyntaxNode): ScriptElement | null {
  const startTag = node.namedChildren.find((child) => child?.type === "start_tag");
  if (!startTag) return null;

  const attributes = new Map<string, SyntaxNode | null>();
  for (const attribute of startTag.namedChildren) {
    if (attribute?.type !== "attribute") continue;
    const name = attribute.namedChildren.find((child) => child?.type === "attribute_name")?.text.toLowerCase();
    if (!name || attributes.has(name)) continue;
    const value = attribute.namedChildren.find((child) => child?.type === "attribute_value" || child?.type === "quoted_attribute_value");
    attributes.set(name, value ?? null);
  }

  const type = attributeText(attributes.get("type")).trim().toLowerCase();
  if (!scriptTypes.has(type)) return null;

  const srcNode = attributes.get("src");
  const srcValue = attributeText(srcNode).trim();
  const src = srcNode && srcValue
    ? { value: srcValue, line: startTag.startPosition.row + 1, text: startTag.text }
    : null;

  const raw = node.namedChildren.find((child) => child?.type === "raw_text");
  const endTag = node.namedChildren.find((child) => child?.type === "end_tag");
  const body = raw && raw.text.trim() !== "" ? { start: raw.startIndex, end: raw.endIndex } : null;
  return { src, body, end: endTag ? endTag.startIndex : null };
}

// The value of an attribute, without the quotes of a quoted one.
function attributeText(value: SyntaxNode | null | undefined): string {
  if (!value) return "";
  if (value.type === "quoted_attribute_value") {
    return value.namedChildren.find((child) => child?.type === "attribute_value")?.text ?? "";
  }
  return value.text;
}

// The page text with everything but the inline scripts blanked out (line
// breaks kept). Each script ends with a `;` where its `</script>` starts, so
// two scripts never run into one statement.
function scriptText(source: string, scripts: ScriptElement[]): string {
  const keep = new Uint8Array(source.length);
  const separators = new Set<number>();
  for (const script of scripts) {
    keep.fill(1, script.body!.start, script.body!.end);
    if (script.end !== null) separators.add(script.end);
  }
  let text = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (keep[index] || char === "\n" || char === "\r") text += char;
    else text += separators.has(index) ? ";" : " ";
  }
  return text;
}

// `<script src="app.js">`: a relative path is a relative import of the page
// (`./app.js`, without `?query` or `#hash`). Root-relative paths and URLs are
// kept as written and left unresolved.
function createScriptImportNode(fileNodeId: string, src: { value: string; line: number; text: string }): GraphNode {
  const isUrl = /^[a-z][a-z\d+.-]*:/iu.test(src.value) || src.value.startsWith("//");
  let source = src.value;
  if (!isUrl) {
    source = source.replace(/[?#].*$/su, "");
    if (!source.startsWith("/") && !source.startsWith(".")) source = `./${source}`;
  }
  return {
    id: `${fileNodeId}:import:${src.line}:${source}`,
    label: "Import",
    properties: {
      source,
      specifier: src.text,
      line: src.line,
      isReExport: false,
      isWildcard: false,
      isDynamic: false,
      isCjs: false,
      isTypeOnly: false,
      bindings: null,
    },
  };
}
