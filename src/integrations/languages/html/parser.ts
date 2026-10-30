import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTree, type GrammarName, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { ILanguageParser } from "../../../core/contracts/language-parser.js";
import { parseJsTsSource, type JsTsFrameworkPlugin, type ScriptBlock } from "../js-ts/parser.js";

// Markup files: HTML pages and single-file components (.vue, .svelte,
// .astro). `<script src>` becomes an Import of the file, and inline scripts
// (plus Astro's `---` frontmatter) are parsed as JS/TS of the file itself. The
// scripts are parsed from the file text with everything else blanked out, so
// their positions point into the original file; the markup is parsed with the
// HTML grammar, where template syntax (directives, `{#if}` blocks, `{expr}`)
// reads as attributes and text.

export type MarkupLanguage = "html" | "vue" | "svelte" | "astro";

// `type` values a browser runs as JavaScript; anything else (JSON, templates,
// import maps) is data.
const scriptTypes = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);

type ScriptElement = {
  src: { value: string; line: number; text: string } | null;
  body: CodeRange | null;
  // The `lang` attribute of a component script (`ts`, `tsx`, …).
  lang: string;
  // Attribute names of the start tag, lowercase (`setup`, `context`, …).
  attributeNames: string[];
  line: number;
  endLine: number;
};

// Code to keep; `end` is where a `;` goes (the start of `</script>` or of the
// closing `---`), so two blocks never run into one statement.
type CodeRange = { start: number; end: number; separator: number | null };

// Semantics of the markup itself (event attributes, for example). Page
// plugins run after the scripts are parsed, on the HTML tree, and add to
// `parsed`; the tree is freed afterwards.
export interface HtmlPagePlugin {
  readonly name: string;
  onPage(page: { fileNodeId: string; documentNode: SyntaxNode; parsed: ParsedSourceFile }): void;
}

export function createMarkupParser(
  language: MarkupLanguage,
  plugins: readonly JsTsFrameworkPlugin[] = [],
  pagePlugins: readonly HtmlPagePlugin[] = [],
): ILanguageParser {
  return {
    language,
    parse: (rootPath, filePath) => parseMarkupFile(rootPath, filePath, language, plugins, pagePlugins),
  };
}

export function createHtmlParser(
  plugins: readonly JsTsFrameworkPlugin[] = [],
  pagePlugins: readonly HtmlPagePlugin[] = [],
): ILanguageParser {
  return createMarkupParser("html", plugins, pagePlugins);
}

export async function parseMarkupFile(
  rootPath: string,
  filePath: string,
  language: MarkupLanguage,
  plugins: readonly JsTsFrameworkPlugin[] = [],
  pagePlugins: readonly HtmlPagePlugin[] = [],
): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const frontmatter = language === "astro" ? astroFrontmatter(source) : null;
  // The markup without the frontmatter, whose `<` would read as tags.
  const markup = frontmatter ? keepOnly(source, [], { start: 0, end: frontmatter.fenceEnd }) : source;
  const tree = await parseSyntaxTree("html", markup);
  try {
    const parsed = await parseMarkup(rootPath, filePath, source, language, frontmatter?.code ?? null, tree.rootNode, plugins);
    for (const plugin of pagePlugins) plugin.onPage({ fileNodeId: parsed.fileNodeId, documentNode: tree.rootNode, parsed });
    return parsed;
  } finally {
    tree.delete();
  }
}

async function parseMarkup(
  rootPath: string,
  filePath: string,
  source: string,
  language: MarkupLanguage,
  frontmatter: CodeRange | null,
  documentNode: SyntaxNode,
  plugins: readonly JsTsFrameworkPlugin[],
): Promise<ParsedSourceFile> {
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const scripts = scriptElements(documentNode);

  const inline = scripts.filter((script) => !script.src && script.body);
  const code = [...(frontmatter ? [frontmatter] : []), ...inline.map((script) => script.body!)];
  // Astro scripts are TypeScript; HTML scripts are JavaScript; component
  // scripts say which in `lang`.
  const langs = language === "astro" ? ["ts"] : inline.map((script) => script.lang);
  const grammar = scriptGrammar(langs);
  const blocks: ScriptBlock[] = inline.map((script) => ({
    start: script.body!.start,
    end: script.body!.end,
    line: script.line,
    endLine: script.endLine,
    attributes: script.attributeNames,
  }));
  const parsed: ParsedSourceFile = code.length > 0
    ? await parseJsTsSource(
      rootPath,
      filePath,
      keepOnly(source, code),
      grammar === "javascript" ? "javascript" : "typescript",
      plugins,
      language,
      grammar,
      blocks,
    )
    : {
      fileNodeId,
      nodes: [{ id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language } }],
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
  const body = raw && raw.text.trim() !== ""
    ? { start: raw.startIndex, end: raw.endIndex, separator: endTag ? endTag.startIndex : null }
    : null;
  return {
    src,
    body,
    lang: attributeText(attributes.get("lang")).trim().toLowerCase(),
    attributeNames: [...attributes.keys()],
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

// The grammar for a file's scripts: TSX when one uses `lang="tsx"`, else
// TypeScript when one is TypeScript, else JavaScript (whose grammar has JSX).
function scriptGrammar(langs: readonly string[]): GrammarName {
  if (langs.includes("tsx")) return "tsx";
  return langs.some((lang) => lang === "ts" || lang === "typescript") ? "typescript" : "javascript";
}

// Astro's `---` fenced frontmatter at the start of the file: the code between
// the fences, and the end of the closing fence.
function astroFrontmatter(source: string): { code: CodeRange; fenceEnd: number } | null {
  const opening = /^\s*---[ \t]*\r?\n/u.exec(source);
  if (!opening) return null;
  const start = opening[0].length;
  const closing = /^---[ \t]*$/mu.exec(source.slice(start));
  if (!closing) return null;
  const end = start + closing.index;
  return { code: { start, end, separator: end }, fenceEnd: end + closing[0].length };
}

// The value of an attribute, without the quotes of a quoted one.
function attributeText(value: SyntaxNode | null | undefined): string {
  if (!value) return "";
  if (value.type === "quoted_attribute_value") {
    return value.namedChildren.find((child) => child?.type === "attribute_value")?.text ?? "";
  }
  return value.text;
}

// `source` with everything but the `code` ranges blanked out (line breaks
// kept), or, with `blank`, with only that range blanked out.
function keepOnly(source: string, code: readonly CodeRange[], blank?: { start: number; end: number }): string {
  const keep = new Uint8Array(source.length);
  const separators = new Set<number>();
  if (blank) {
    keep.fill(1);
    keep.fill(0, blank.start, blank.end);
  }
  for (const range of code) {
    keep.fill(1, range.start, range.end);
    if (range.separator !== null) separators.add(range.separator);
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
