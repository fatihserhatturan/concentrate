import type { ParsedSourceFile } from "../graph/model.js";
import type { SupportedLanguage } from "../scan/language.js";

export interface ILanguageParser {
  readonly language: SupportedLanguage;
  parse(rootPath: string, filePath: string): Promise<ParsedSourceFile>;
}

export type { ILanguageParser as LanguageParser };
