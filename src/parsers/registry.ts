import type { ParsedSourceFile } from "../graph/model.js";
import type { SupportedLanguage } from "../scanner/language.js";
import { javascriptParser, typescriptParser } from "./javascript-like.js";
import { goParser } from "./go.js";
import { pythonParser } from "./python.js";
import { rustParser } from "./rust.js";
import type { LanguageParser } from "./types.js";

const languageParsers = new Map<SupportedLanguage, LanguageParser>();

registerLanguageParser(javascriptParser);
registerLanguageParser(typescriptParser);
registerLanguageParser(pythonParser);
registerLanguageParser(goParser);
registerLanguageParser(rustParser);

export function registerLanguageParser(parser: LanguageParser): void {
  languageParsers.set(parser.language, parser);
}

export function getLanguageParser(language: SupportedLanguage): LanguageParser {
  const parser = languageParsers.get(language);
  if (!parser) {
    throw new Error(`No parser registered for language: ${language}`);
  }

  return parser;
}

export function parseSourceFile(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<ParsedSourceFile> {
  return getLanguageParser(language).parse(rootPath, filePath);
}
