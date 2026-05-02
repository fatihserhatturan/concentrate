import type { ParsedSourceFile } from "../graph/model.js";

export interface ILanguageParser {
  readonly language: string;
  parse(rootPath: string, filePath: string): Promise<ParsedSourceFile>;
}
