import path from "node:path";
import { open, readFile, stat } from "node:fs/promises";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import type { GraphNode, ParsedSourceFile } from "../../../core/graph/model.js";
import { lockfiles } from "../../../core/scan/file-classification.js";
import { CODE_LANGUAGES, type FileLanguage, type SupportedLanguage } from "../../../core/scan/language.js";
import { withSyntaxTree, type GrammarName, type SyntaxNode } from "../syntax/tree-sitter.js";
import { readDockerfile } from "./dockerfile.js";
import { readProto } from "./proto.js";
import { styleGraph } from "./style-graph.js";
import { protoGraph } from "./proto-graph.js";

// The non-code files of a project (styles, JSON, YAML, scripts, docs,
// assets, …) become `File` nodes so the graph shows every file and imports of
// them resolve. Files with a grammar or a small reader are checked for syntax
// errors: the node is kept and the scan reports a warning. Their contents are
// not read for declarations here; a file of unknown type whose first bytes
// hold a NUL is an `asset`.

const SNIFF_BYTES = 8000;

// Larger files are nodes but are not parsed (data dumps, bundles).
export const MAX_PARSED_BYTES = 1_000_000;

const grammars: Partial<Record<FileLanguage, GrammarName>> = {
  css: "css",
  scss: "scss",
  json: "json",
  yaml: "yaml",
  shell: "bash",
  powershell: "powershell",
  makefile: "make",
  sql: "sql",
};

// Languages whose syntax errors are reported. The css, scss and sql grammars
// are vendored for the readers of Phases 24 and 25 but do not warn: on real
// projects they reject valid code (CSS range media queries `width <= 768px`,
// `;;`, MySQL backticks and `/*! … */` comments, `LIMIT $2`, `FOR NO KEY
// UPDATE`), so a warning would be wrong more often than right.
const warnsOnSyntaxErrors: ReadonlySet<FileLanguage> = new Set([
  "json", "yaml", "shell", "powershell", "makefile", "dockerfile", "proto",
]);

// JSON that tools read with comments and trailing commas.
function allowsComments(relativePath: string): boolean {
  const segments = relativePath.split(path.sep).join("/").split("/");
  const name = segments.at(-1) ?? "";
  return /\.(?:jsonc|json5)$/u.test(name)
    || /^(?:[jt]sconfig|\.eslintrc|\.babelrc|\.swcrc|devcontainer|tslint)[\w.-]*\.json$/u.test(name)
    || /^\.(?:eslintrc|babelrc|prettierrc|swcrc)$/u.test(name)
    || segments.includes(".vscode");
}

async function looksBinary(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

// Lines of the first syntax errors of a tree, at most `limit`.
function errorLines(root: SyntaxNode, limit: number): number[] {
  const lines = new Set<number>();
  const visit = (node: SyntaxNode) => {
    if (lines.size >= limit) return;
    if (node.isError || node.isMissing) {
      lines.add(node.startPosition.row + 1);
      return;
    }
    for (const child of node.children) {
      if (child.hasError || child.isMissing) visit(child);
    }
  };
  visit(root);
  return [...lines].sort((a, b) => a - b);
}

function syntaxWarning(lines: number[]): string {
  return `Syntax error at line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}`;
}

async function syntaxWarnings(filePath: string, relativePath: string, language: FileLanguage): Promise<string[]> {
  // package.json is read (and its errors reported) by the project config reader.
  if (lockfiles.has(path.basename(filePath)) || path.basename(filePath) === "package.json") return [];
  if (!warnsOnSyntaxErrors.has(language)) return [];
  const grammar = grammars[language];
  const hasReader = language === "dockerfile" || language === "proto";
  if (!grammar && !hasReader) return [];
  if (language === "json" && allowsComments(relativePath)) return [];
  if ((await stat(filePath)).size > MAX_PARSED_BYTES) return [];

  const source = await readFile(filePath, "utf8");
  // Helm, Jinja and Ansible fill YAML in: `{{ .Values.x }}` is not YAML.
  if (language === "yaml" && source.includes("{{")) return [];
  if (grammar) {
    const lines = await withSyntaxTree(grammar, source, (tree) => (tree.rootNode.hasError ? errorLines(tree.rootNode, 5) : []));
    return lines.length > 0 ? [syntaxWarning(lines)] : [];
  }
  const errors = language === "dockerfile" ? readDockerfile(source).errors : readProto(source).errors;
  const lines = [...new Set(errors.map((error) => error.line))].slice(0, 5);
  return lines.length > 0 ? [syntaxWarning(lines)] : [];
}

async function parsePlainFile(rootPath: string, filePath: string, language: FileLanguage): Promise<ParsedSourceFile> {
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const detected = language === "other" && await looksBinary(filePath) ? "asset" : language;
  const warnings = detected === "other" || detected === "asset" ? [] : await syntaxWarnings(filePath, relativePath, detected);
  const fileNode: GraphNode = { id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language: detected } };
  const parsed: ParsedSourceFile = {
    fileNodeId,
    nodes: [fileNode],
    relationships: [],
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  if ((detected === "css" || detected === "scss" || detected === "less") && !lockfiles.has(path.basename(filePath)) && (await stat(filePath)).size <= MAX_PARSED_BYTES) {
    styleGraph(fileNodeId, relativePath, detected, await readFile(filePath, "utf8"), parsed);
  }
  if (detected === "proto" && (await stat(filePath)).size <= MAX_PARSED_BYTES) {
    protoGraph(fileNodeId, await readFile(filePath, "utf8"), parsed);
  }
  return parsed;
}

const fileLanguages: FileLanguage[] = [
  "css", "scss", "less", "json", "yaml", "toml", "markdown",
  "shell", "powershell", "dockerfile", "makefile", "sql", "proto",
  "other", "asset",
];

export const plainFileParsers: LanguageParser[] = fileLanguages.map((language) => ({
  language,
  parse: (rootPath, filePath) => parsePlainFile(rootPath, filePath, language),
}));

export function isPlainLanguage(language: SupportedLanguage): language is FileLanguage {
  return !CODE_LANGUAGES.has(language);
}
