import path from "node:path";
import { open } from "node:fs/promises";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import type { ParsedSourceFile } from "../../../core/graph/model.js";
import { CODE_LANGUAGES, type FileLanguage, type SupportedLanguage } from "../../../core/scan/language.js";

// The non-code files of a project (styles, JSON, YAML, scripts, docs,
// assets, …) become `File` nodes so the graph shows every file and imports of
// them resolve. Their contents are not read for declarations here; a file of
// unknown type whose first bytes hold a NUL is an `asset`.

const SNIFF_BYTES = 8000;

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

async function parsePlainFile(rootPath: string, filePath: string, language: FileLanguage): Promise<ParsedSourceFile> {
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const detected = language === "other" && await looksBinary(filePath) ? "asset" : language;
  return {
    fileNodeId,
    nodes: [{ id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language: detected } }],
    relationships: [],
  };
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
