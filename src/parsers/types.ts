import type { ParsedSourceFile } from "../graph/model.js";
import type { SupportedLanguage } from "../scanner/language.js";

export type LanguageParser = {
  language: SupportedLanguage;
  parse(rootPath: string, filePath: string): Promise<ParsedSourceFile>;
};
