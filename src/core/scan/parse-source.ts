import type { SupportedLanguage } from "./language.js";
import type { ParsedSourceFile } from "../graph/model.js";
import type { ILanguageParser } from "../contracts/language-parser.js";

export type ParseResult =
  | { ok: true; parsed: ParsedSourceFile; filePath: string }
  | { ok: false; error: unknown; filePath: string };

export async function parseFileWithContext(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
  parser: ILanguageParser,
): Promise<ParsedSourceFile> {
  try {
    return await parser.parse(rootPath, filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${filePath}: ${message}`, { cause: error });
  }
}
